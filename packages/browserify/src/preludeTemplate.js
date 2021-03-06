// LavaMoat Prelude
(function() {

  const debugMode = __lavamoatDebugMode__

  // identify the globalRef
  const globalRef = (typeof self !== 'undefined') ? self : global

  // define SES
  // "templateRequire" calls are inlined in "generatePrelude"
  const SES = templateRequire('ses')

  const sesOptions = {
    // this is introduces non-determinism, but is otherwise safe
    mathRandomMode: 'allow',
  }

  // only reveal error stacks in debug mode
  if (debugMode === true) {
    sesOptions.errorStackMode = 'allow'
  }

  const realm = SES.makeSESRootRealm(sesOptions)

  // create SES-wrapped internalRequire
  const makeKernel = realm.evaluate(`(${unsafeMakeKernel})`, { console })
  const { loadBundle } = makeKernel({
    realm,
    unsafeEvalWithEndowments,
    globalRef,
    debugMode,
  })

  // create a lavamoat pulic API for loading modules over multiple files
  const lavamoatPublicApi = Object.freeze({
    loadBundle: Object.freeze(loadBundle),
  })
  globalRef.LavaMoat = lavamoatPublicApi

  return loadBundle


  // this performs an unsafeEval in the context of the provided endowments
  function unsafeEvalWithEndowments(code, endowments) {
    with (endowments) {
      return eval(code)
    }
  }

  // this is serialized and run in SES
  // mostly just exists to expose variables to internalRequire and loadBundle
  function unsafeMakeKernel ({
    realm,
    unsafeEvalWithEndowments,
    globalRef,
    debugMode,
  }) {
    // "templateRequire" calls are inlined in "generatePrelude"
    const { getEndowmentsForConfig } = templateRequire('makeGetEndowmentsForConfig')()
    const { prepareRealmGlobalFromConfig } = templateRequire('makePrepareRealmGlobalFromConfig')()
    const { Membrane } = templateRequire('cytoplasm')
    const createReadOnlyDistortion = templateRequire('cytoplasm/distortions/readOnly')

    // manifest
    const lavamoatConfig = { resources: {} }

    const modules = {}
    const moduleCache = new Map()
    const globalStore = new Map()
    const membraneSpaceForPackage = new Map()
    const membrane = new Membrane({ debugMode })

    return {
      loadBundle,
      internalRequire,
    }

    // it is called by the modules collection that will be appended to this file
    function loadBundle (newModules, entryPoints, newConfig) {
      // verify + load config
      Object.entries(newConfig.resources || {}).forEach(([packageName, packageConfig]) => {
        if (packageName in lavamoatConfig) {
          throw new Error(`LavaMoat - loadBundle encountered redundant config definition for package "${packageName}"`)
        }
        lavamoatConfig.resources[packageName] = packageConfig
      })
      // verify + load in each module
      for (const [moduleId, moduleData] of Object.entries(newModules)) {
        // verify that module is new
        if (moduleId in modules) {
          throw new Error(`LavaMoat - loadBundle encountered redundant module definition for id "${moduleId}"`)
        }
        // convert all module source to string
        // this could happen at build time,
        // but shipping it as code makes it easier to debug, maybe
        for (let moduleData of Object.values(newModules)) {
          let moduleSource = `(${moduleData.source})`
          if (moduleData.file) {
            const moduleSourceLabel = `// moduleSource: ${moduleData.file}`
            moduleSource += `\n\n${moduleSourceLabel}`
          }
          moduleData.sourceString = moduleSource
        }
        // add the module
        modules[moduleId] = moduleData
      }
      // run each of entryPoints
      const entryExports = Array.prototype.map.call(entryPoints, (entryId) => {
        return internalRequire(entryId)
      })
      // webpack compat: return the first module's exports
      return entryExports[0]
    }

    // this function instantiaties a module from a moduleId.
    // 1. loads the config for the module
    // 2. instantiates in the config specified environment
    // 3. calls config specified strategy for "protectExportsInstantiationTime"
    function internalRequire (moduleId) {
      if (moduleCache.has(moduleId)) {
        const moduleExports = moduleCache.get(moduleId).exports
        return moduleExports
      }
      const moduleData = modules[moduleId]

      // if we dont have it, throw an error
      if (!moduleData) {
        const err = new Error('Cannot find module \'' + moduleId + '\'')
        err.code = 'MODULE_NOT_FOUND'
        throw err
      }

      // prepare the module to be initialized
      const packageName = moduleData.package
      const moduleSource = moduleData.sourceString
      const configForModule = getConfigForPackage(lavamoatConfig, packageName)
      const packageMembraneSpace = getMembraneSpaceForPackage(packageName)
      const isEntryModule = moduleData.package === '<root>'

      // create the initial moduleObj
      const moduleObj = { exports: {} }
      // cache moduleObj here
      moduleCache.set(moduleId, moduleObj)
      // this is important for multi-module circles in the dep graph
      // if you dont cache before running the moduleInitializer

      // prepare endowments
      const endowmentsFromConfig = getEndowmentsForConfig(globalRef, configForModule)
      let endowments = Object.assign({}, lavamoatConfig.defaultGlobals, endowmentsFromConfig)
      // special case for exposing window
      if (endowments.window) {
        endowments = Object.assign({}, endowments.window, endowments)
      }

      // the default environment is "unfrozen" for the app root modules, "frozen" for dependencies
      // this may be a bad default, but was meant to ease app development
      // "frozen" means in a SES container
      // "unfrozen" means via unsafeEvalWithEndowments
      const environment = configForModule.environment || (isEntryModule ? 'unfrozen' : 'frozen')
      const runInSes = environment !== 'unfrozen'

      let moduleInitializer
      // determine if its a SES-wrapped or naked module initialization
      if (runInSes) {
        // set the module initializer as the SES-wrapped version
        const moduleRealm = realm.global.Realm.makeCompartment()
        const globalsConfig = configForModule.globals
        const endowmentsMembraneSpace = getMembraneSpaceForPackage('<endowments>')
        const membraneEndowments = membrane.bridge(endowments, endowmentsMembraneSpace, packageMembraneSpace)
        prepareRealmGlobalFromConfig(moduleRealm.global, globalsConfig, membraneEndowments, globalStore)
        // execute in module realm with modified realm global
        try {
          moduleInitializer = moduleRealm.evaluate(`${moduleSource}`)
        } catch (err) {
          console.warn(`LavaMoat - Error evaluating module "${moduleId}" from package "${packageName}"`)
          throw err
        }
      } else {
        endowments.global = globalRef
        // set the module initializer as the unwrapped version
        moduleInitializer = unsafeEvalWithEndowments(`${moduleSource}`, endowments)
      }
      if (typeof moduleInitializer !== 'function') {
        throw new Error(`LavaMoat - moduleInitializer is not defined correctly. got "${typeof moduleInitializer}" ses:${runInSes}\n${moduleSource}`)
      }

      // browserify goop:
      // this "modules" interface is exposed to the browserify moduleInitializer
      // https://github.com/browserify/browser-pack/blob/cd0bd31f8c110e19a80429019b64e887b1a82b2b/prelude.js#L38
      // browserify's browser-resolve uses "arguments[4]" to do direct module initializations
      // browserify seems to do this when module references are redirected by the "browser" field
      // this proxy shims this behavior
      // TODO: would be better to just fix this by removing the indirection (maybe in https://github.com/browserify/module-deps?)
      // though here and in the original browser-pack prelude it has a side effect that it is re-instantiated from the original module (no shared closure state)
      const directModuleInstantiationInterface = new Proxy({}, {
        get (_, targetModuleId) {
          const fakeModuleDefinition = [fakeModuleInitializer]
          return fakeModuleDefinition

          function fakeModuleInitializer () {
            const targetModuleExports = requireRelativeWithContext(targetModuleId)
            moduleObj.exports = targetModuleExports
          }
        }
      })

      // initialize the module with the correct context
      moduleInitializer.call(moduleObj.exports, requireRelativeWithContext, moduleObj, moduleObj.exports, null, directModuleInstantiationInterface)

      // configure membrane defense
      // defense is configured here but applied elsewhere
      // set moduleExports graph to read-only
      const moduleExports = moduleObj.exports
      deepWalk(moduleExports, (value) => {
        // skip plain values
        if (membrane.shouldSkipBridge(value)) return
        // set this ref to read-only
        packageMembraneSpace.handlerForRef.set(value, createReadOnlyDistortion({
          setHandlerForRef: (ref, newHandler) => packageMembraneSpace.handlerForRef.set(ref, newHandler)
        }))
      })

      return moduleExports

      // this is passed to the module initializer
      // it adds the context of the parent module
      // this could be replaced via "Function.prototype.bind" if its more performant
      function requireRelativeWithContext (requestedName) {
        const parentModuleExports = moduleObj.exports
        const parentModuleData = moduleData
        const parentPackageConfig = configForModule
        const parentModuleId = moduleId
        return requireRelative({ requestedName, parentModuleExports, parentModuleData, parentPackageConfig, parentModuleId })
      }

    }

    // this resolves a module given a requestedName (eg relative path to parent) and a parentModule context
    // the exports are processed via "protectExportsRequireTime" per the module's configuration
    function requireRelative ({ requestedName, parentModuleExports, parentModuleData, parentPackageConfig, parentModuleId }) {
      const parentModulePackageName = parentModuleData.package
      const parentModuleDepsMap = parentModuleData.deps
      const parentPackagesWhitelist = parentPackageConfig.packages

      // resolve the moduleId from the requestedName
      // this is just a warning if the entry is missing in the deps map (local requestedName -> global moduleId)
      // if it is missing we try to fetch it anyways using the requestedName as the moduleId
      // The dependency whitelist should still be enforced elsewhere
      const moduleId = parentModuleDepsMap[requestedName] || requestedName
      if (!(requestedName in parentModuleData.deps)) {
        console.warn(`missing dep: ${parentModulePackageName} requested ${requestedName}`)
      }

      // browserify goop:
      // recursive requires dont hit cache so it inf loops, so we shortcircuit
      // this only seems to happen with a few browserify builtins (nodejs builtin module polyfills)
      // we could likely allow any requestedName since it can only refer to itself
      if (moduleId === parentModuleId) {
        if (['timers', 'buffer'].includes(requestedName) === false) {
          throw new Error(`LavaMoat - recursive require detected: "${requestedName}"`)
        }
        return parentModuleExports
      }

      // load module
      const moduleExports = internalRequire(moduleId)

      // look up config for module
      const moduleData = modules[moduleId]
      const packageName = moduleData.package
      const configForModule = getConfigForPackage(lavamoatConfig, packageName)

      // disallow requiring packages that are not in the parent's whitelist
      const isSamePackage = packageName === parentModulePackageName
      const isInParentWhitelist = packageName in parentPackagesWhitelist
      const parentIsEntryModule = parentModulePackageName === '<root>'

      if (!parentIsEntryModule && !isSamePackage && !isInParentWhitelist) {
        throw new Error(`LavaMoat - required package not in whitelist: package "${parentModulePackageName}" requested "${packageName}" as "${requestedName}"`)
      }

      // moduleExports require-time protection
      if (parentModulePackageName && isSamePackage) {
        // return raw if same package
        return moduleExports
      } else {
        // apply membrane protections
        const inGraph = getMembraneSpaceForPackage(packageName)
        let outGraph
        // set <root>'s membrane space to <endowments> so it receives unwrapped refs
        if (parentModulePackageName === '<root>') {
          outGraph = getMembraneSpaceForPackage('<endowments>')
        } else {
          outGraph = getMembraneSpaceForPackage(parentModulePackageName)
        }
        const protectedExports = membrane.bridge(moduleExports, inGraph, outGraph)
        return protectedExports
      }
    }

    function getMembraneSpaceForPackage (packageName) {
      if (membraneSpaceForPackage.has(packageName)) {
        return membraneSpaceForPackage.get(packageName)
      }

      const membraneSpace = membrane.makeMembraneSpace({
        label: packageName,
        // default is a transparent membrane handler
        createHandler: () => Reflect,
      })
      membraneSpaceForPackage.set(packageName, membraneSpace)
      return membraneSpace
    }

    function deepWalk (value, visitor) {
      // the value itself
      visitor(value)
      // lookup children
      let proto, props = []
      try {
        proto = Object.getPrototypeOf(value)
        props = Object.values(Object.getOwnPropertyDescriptors(value))
      } catch (_) {
        // ignore error if we can't get proto/props (value is undefined, null, etc)
      }
      // the own properties
      props.map(entry => {
        if ('value' in entry) visitor(entry.value)
      })
      // the prototype
      if (proto) visitor(proto)
    }

    // this gets the lavaMoat config for a module by packageName
    // if there were global defaults (e.g. everything gets "console") they could be applied here
    function getConfigForPackage (config, packageName) {
      const packageConfig = (config.resources || {})[packageName] || {}
      packageConfig.globals = packageConfig.globals || {}
      packageConfig.packages = packageConfig.packages || {}
      return packageConfig
    }

    //# sourceURL=internalRequire
  }

})()
