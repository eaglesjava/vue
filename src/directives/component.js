var _ = require('../util')
var config = require('../config')
var templateParser = require('../parsers/template')

module.exports = {

  isLiteral: true,

  /**
   * Setup. Two possible usages:
   *
   * - static:
   *   v-component="comp"
   *
   * - dynamic:
   *   v-component="{{currentView}}"
   */

  bind: function () {
    if (!this.el.__vue__) {
      // create a ref anchor
      this.anchor = _.createAnchor('v-component')
      _.replace(this.el, this.anchor)
      // check keep-alive options.
      // If yes, instead of destroying the active vm when
      // hiding (v-if) or switching (dynamic literal) it,
      // we simply remove it from the DOM and save it in a
      // cache object, with its constructor id as the key.
      this.keepAlive = this._checkParam('keep-alive') != null
      // wait for event before insertion
      this.readyEvent = this._checkParam('wait-for')
      // check ref
      this.refID = this._checkParam(config.prefix + 'ref')
      if (this.keepAlive) {
        this.cache = {}
      }
      // check inline-template
      if (this._checkParam('inline-template') !== null) {
        // extract inline template as a DocumentFragment
        this.template = _.extractContent(this.el, true)
      }
      // component resolution related state
      this.pendingComponentCb =
      this.componentID =
      this.Component = null
      // transition related state
      this.pendingRemovals = 0
      this.pendingRemovalCb = null
      // if static, build right now.
      if (!this._isDynamicLiteral) {
        this.resolveComponent(this.expression, _.bind(this.initStatic, this))
      } else {
        // check dynamic component params
        this.transMode = this._checkParam('transition-mode')
      }
    } else {
      process.env.NODE_ENV !== 'production' && _.warn(
        'cannot mount component "' + this.expression + '" ' +
        'on already mounted element: ' + this.el
      )
    }
  },

  /**
   * Initialize a static component.
   */

  initStatic: function () {
    var child = this.build()
    var anchor = this.anchor
    this.setCurrent(child)
    if (!this.readyEvent) {
      child.$before(anchor)
    } else {
      child.$once(this.readyEvent, function () {
        child.$before(anchor)
      })
    }
  },

  /**
   * Public update, called by the watcher in the dynamic
   * literal scenario, e.g. v-component="{{view}}"
   */

  update: function (value) {
    this.setComponent(value)
  },

  /**
   * Switch dynamic components. May resolve the component
   * asynchronously, and perform transition based on
   * specified transition mode. Accepts a few additional
   * arguments specifically for vue-router.
   *
   * @param {String} value
   * @param {Object} data
   * @param {Function} afterBuild
   * @param {Function} afterTransition
   */

  setComponent: function (value, data, afterBuild, afterTransition) {
    this.invalidatePending()
    if (!value) {
      // just remove current
      this.unbuild(true)
      this.remove(this.childVM, afterTransition)
      this.unsetCurrent()
    } else {
      this.resolveComponent(value, _.bind(function () {
        this.unbuild(true)
        var newComponent = this.build(data)
        /* istanbul ignore if */
        if (afterBuild) afterBuild(newComponent)
        var self = this
        if (this.readyEvent) {
          newComponent.$once(this.readyEvent, function () {
            self.transition(newComponent, afterTransition)
          })
        } else {
          this.transition(newComponent, afterTransition)
        }
      }, this))
    }
  },

  /**
   * Resolve the component constructor to use when creating
   * the child vm.
   */

  resolveComponent: function (id, cb) {
    var self = this
    this.pendingComponentCb = _.cancellable(function (component) {
      self.componentID = id
      self.Component = component
      cb()
    })
    this.vm._resolveComponent(id, this.pendingComponentCb)
  },

  /**
   * When the component changes or unbinds before an async
   * constructor is resolved, we need to invalidate its
   * pending callback.
   */

  invalidatePending: function () {
    if (this.pendingComponentCb) {
      this.pendingComponentCb.cancel()
      this.pendingComponentCb = null
    }
  },

  /**
   * Instantiate/insert a new child vm.
   * If keep alive and has cached instance, insert that
   * instance; otherwise build a new one and cache it.
   *
   * @param {Object} [data]
   * @return {Vue} - the created instance
   */

  build: function (data) {
    if (this.keepAlive) {
      var cached = this.cache[this.componentID]
      if (cached) {
        return cached
      }
    }
    if (this.Component) {
      var parent = this._host || this.vm
      var el = templateParser.clone(this.el)
      var child = parent.$addChild({
        el: el,
        data: data,
        template: this.template,
        // if no inline-template, then the compiled
        // linker can be cached for better performance.
        _linkerCachable: !this.template,
        _asComponent: true,
        _isRouterView: this._isRouterView,
        _context: this.vm
      }, this.Component)
      if (this.keepAlive) {
        this.cache[this.componentID] = child
      }
      return child
    }
  },

  /**
   * Teardown the current child, but defers cleanup so
   * that we can separate the destroy and removal steps.
   *
   * @param {Boolean} defer
   */

  unbuild: function (defer) {
    var child = this.childVM
    if (!child || this.keepAlive) {
      return
    }
    // the sole purpose of `deferCleanup` is so that we can
    // "deactivate" the vm right now and perform DOM removal
    // later.
    child.$destroy(false, defer)
  },

  /**
   * Remove current destroyed child and manually do
   * the cleanup after removal.
   *
   * @param {Function} cb
   */

  remove: function (child, cb) {
    var keepAlive = this.keepAlive
    if (child) {
      // we may have a component switch when a previous
      // component is still being transitioned out.
      // we want to trigger only one lastest insertion cb
      // when the existing transition finishes. (#1119)
      this.pendingRemovals++
      this.pendingRemovalCb = cb
      var self = this
      child.$remove(function () {
        self.pendingRemovals--
        if (!keepAlive) child._cleanup()
        if (!self.pendingRemovals && self.pendingRemovalCb) {
          self.pendingRemovalCb()
          self.pendingRemovalCb = null
        }
      })
    } else if (cb) {
      cb()
    }
  },

  /**
   * Actually swap the components, depending on the
   * transition mode. Defaults to simultaneous.
   *
   * @param {Vue} target
   * @param {Function} [cb]
   */

  transition: function (target, cb) {
    var self = this
    var current = this.childVM
    this.unsetCurrent()
    this.setCurrent(target)
    switch (self.transMode) {
      case 'in-out':
        target.$before(self.anchor, function () {
          self.remove(current, cb)
        })
        break
      case 'out-in':
        self.remove(current, function () {
          target.$before(self.anchor, cb)
        })
        break
      default:
        self.remove(current)
        target.$before(self.anchor, cb)
    }
  },

  /**
   * Set childVM and parent ref
   */

  setCurrent: function (child) {
    this.childVM = child
    var refID = child._refID || this.refID
    if (refID) {
      this.vm.$[refID] = child
    }
  },

  /**
   * Unset childVM and parent ref
   */

  unsetCurrent: function () {
    var child = this.childVM
    this.childVM = null
    var refID = (child && child._refID) || this.refID
    if (refID) {
      this.vm.$[refID] = null
    }
  },

  /**
   * Unbind.
   */

  unbind: function () {
    this.invalidatePending()
    // Do not defer cleanup when unbinding
    this.unbuild()
    this.unsetCurrent()
    // destroy all keep-alive cached instances
    if (this.cache) {
      for (var key in this.cache) {
        this.cache[key].$destroy()
      }
      this.cache = null
    }
  }
}
