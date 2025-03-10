'use strict'

var tls = require('tls')
var http = require('http')
var https = require('https')
var http2 = require('./lib/http2')
var autohttp2 = require('./lib/autohttp')
var url = require('url')
var util = require('util')
var stream = require('stream')
var zlib = require('zlib')
var aws2 = require('aws-sign2')
var aws4 = require('aws4')
var uuid = require('uuid').v4
var httpSignature = require('http-signature')
var mime = require('mime-types')
var caseless = require('caseless')
var ForeverAgent = require('forever-agent')
var FormData = require('@postman/form-data')
var extend = require('extend')
var isstream = require('isstream')
var streamLength = require('stream-length')
var isTypedArray = require('is-typedarray').strict
var helpers = require('./lib/helpers')
var cookies = require('./lib/cookies')
var getProxyFromURI = require('./lib/getProxyFromURI')
var Querystring = require('./lib/querystring').Querystring
var Har = require('./lib/har').Har
var Auth = require('./lib/auth').Auth
var OAuth = require('./lib/oauth').OAuth
var hawk = require('./lib/hawk')
var Multipart = require('./lib/multipart').Multipart
var Redirect = require('./lib/redirect').Redirect
var Tunnel = require('./lib/tunnel').Tunnel
var Buffer = require('safe-buffer').Buffer
var inflate = require('./lib/inflate')
var urlParse = require('./lib/url-parse')
var safeStringify = helpers.safeStringify
var isReadStream = helpers.isReadStream
var toBase64 = helpers.toBase64
var defer = helpers.defer
var copy = helpers.copy
var version = helpers.version
var now = helpers.now
var SizeTrackerStream = helpers.SizeTrackerStream
var globalCookieJar = cookies.jar()

var globalPool = {}

function filterForNonReserved (reserved, options) {
  // Filter out properties that are not reserved.
  // Reserved values are passed in at call site.

  var object = {}
  for (var i in options) {
    var notReserved = (reserved.indexOf(i) === -1)
    if (notReserved) {
      object[i] = options[i]
    }
  }
  return object
}

function filterOutReservedFunctions (reserved, options) {
  // Filter out properties that are functions and are reserved.
  // Reserved values are passed in at call site.

  var object = {}
  for (var i in options) {
    var isReserved = !(reserved.indexOf(i) === -1)
    var isFunction = (typeof options[i] === 'function')
    if (!(isReserved && isFunction)) {
      object[i] = options[i]
    }
  }
  return object
}

function transformFormData (formData) {
  // Transform the object representation of form-data fields to array representation.
  // This might not preserve the order of form fields defined in object representation.
  // But, this transformation is required to support backward compatibility.
  //
  // Form-Data should be stored as an array to respect the fields order.
  // RFC 7578#section-5.2  Ordered Fields and Duplicated Field Names
  // https://tools.ietf.org/html/rfc7578#section-5.2

  var transformedFormData = []
  var appendFormParam = function (key, param) {
    transformedFormData.push({
      key: key,
      value: param && param.hasOwnProperty('value') ? param.value : param,
      options: param && param.hasOwnProperty('options') ? param.options : undefined
    })
  }
  for (var formKey in formData) {
    if (formData.hasOwnProperty(formKey)) {
      var formValue = formData[formKey]
      if (Array.isArray(formValue)) {
        for (var j = 0; j < formValue.length; j++) {
          appendFormParam(formKey, formValue[j])
        }
      } else {
        appendFormParam(formKey, formValue)
      }
    }
  }
  return transformedFormData
}

// Return a simpler request object to allow serialization
function requestToJSON () {
  var self = this
  return {
    uri: self.uri,
    method: self.method,
    headers: self.headers
  }
}

// Return a simpler response object to allow serialization
function responseToJSON () {
  var self = this
  return {
    statusCode: self.statusCode,
    body: self.body,
    headers: self.headers,
    request: requestToJSON.call(self.request)
  }
}

/**
 * Return request headers in [{key: headerName, value: headerValue}] form
 * @param {String} [headerString] - headers string created by Node stored in ClientRequest._header
 *
 * */
function parseRequestHeaders (headerString) {
  var arr = headerString.split('\r\n')
  var acc = []

  // first element of accumulator is not a header
  // last two elements are empty strings
  for (var i = 1; i < arr.length - 2; i++) {
    // HTTP/2 specific headers beging with :, so we find the index of the first colon skipping the first character
    var splitIndex = arr[i].indexOf(':', 1)

    acc.push({
      key: arr[i].slice(0, splitIndex),
      value: arr[i].slice(splitIndex + 2)
    })
  }

  return acc
}

/**
 * Return response headers in [{key: headerName, value: headerValue}] form
 * @param {Array} [rawHeaders] - https://nodejs.org/api/http.html#http_message_rawheaders
 *
 * */
function parseResponseHeaders (rawHeaders) {
  var acc = []

  for (var i = 0; i < rawHeaders.length; i = i + 2) {
    acc.push({
      key: rawHeaders[i],
      value: rawHeaders[i + 1]
    })
  }

  return acc
}

function Request (options) {
  // if given the method property in options, set property explicitMethod to true

  // extend the Request instance with any non-reserved properties
  // remove any reserved functions from the options object
  // set Request instance to be readable and writable
  // call init

  var self = this

  // start with HAR, then override with additional options
  if (options.har) {
    self._har = new Har(self)
    options = self._har.options(options)
  }

  // transform `formData` for backward compatibility
  // don't check for explicit object type to support legacy shenanigans
  if (options.formData && !Array.isArray(options.formData)) {
    options.formData = transformFormData(options.formData)
  }

  // use custom URL parser if provided, fallback to url.parse and url.resolve
  if (!(
    options.urlParser &&
    typeof options.urlParser.parse === 'function' &&
    typeof options.urlParser.resolve === 'function'
  )) {
    options.urlParser = {
      parse: url.parse,
      resolve: url.resolve
    }
  }

  stream.Stream.call(self)
  var reserved = Object.keys(Request.prototype)
  var nonReserved = filterForNonReserved(reserved, options)

  extend(self, nonReserved)
  options = filterOutReservedFunctions(reserved, options)

  self.readable = true
  self.writable = true
  self._debug = []
  if (options.method) {
    self.explicitMethod = true
  }
  self._qs = new Querystring(self)
  self._auth = new Auth(self)
  self._oauth = new OAuth(self)
  self._multipart = new Multipart(self)
  self._redirect = new Redirect(self)
  self._tunnel = new Tunnel(self)
  self.init(options)
}

util.inherits(Request, stream.Stream)

// Debugging
Request.debug = process.env.NODE_DEBUG && /\brequest\b/.test(process.env.NODE_DEBUG)

function debug () {
  if (Request.debug) {
    console.error('REQUEST %s', util.format.apply(util, arguments))
  }
}

Request.prototype.debug = debug

Request.prototype.init = function (options) {
  // init() contains all the code to setup the request object.
  // the actual outgoing request is not started until start() is called
  // this function is called from both the constructor and on redirect.
  var self = this
  if (!options) {
    options = {}
  }
  self.headers = self.headers ? copy(self.headers) : {}

  // for this request (or redirect) store its debug logs in `_reqResInfo` and
  // store its reference in `_debug` which holds debug logs of every request
  self._reqResInfo = {}
  self._debug.push(self._reqResInfo)

  // additional postman feature starts
  // bind default events sent via options
  if (options.bindOn) {
    Object.keys(options.bindOn).forEach(function (eventName) {
      !Array.isArray(options.bindOn[eventName]) && (options.bindOn[eventName] = [options.bindOn[eventName]])
      options.bindOn[eventName].forEach(function (listener) {
        self.on(eventName, listener)
      })
    })
  }
  if (options.once) {
    Object.keys(options.once).forEach(function (eventName) {
      !Array.isArray(options.bindOnce[eventName]) && (options.bindOnce[eventName] = [options.bindOnce[eventName]])
      options.bindOnce[eventName].forEach(function (listener) {
        self.once(eventName, listener)
      })
    })
  }
  // additional postman feature ends

  // Delete headers with value undefined or HTTP/2 specific pseudoheaders since they break
  // ClientRequest.OutgoingMessage.setHeader in node 0.12
  for (var headerName in self.headers) {
    if (typeof self.headers[headerName] === 'undefined' || headerName.startsWith(':')) {
      delete self.headers[headerName]
    }
  }

  caseless.httpify(self, self.headers)

  if (!self.method) {
    self.method = options.method || 'GET'
  }
  if (!self.localAddress) {
    self.localAddress = options.localAddress
  }

  self._qs.init(options)

  debug(options)
  if (!self.pool && self.pool !== false) {
    self.pool = globalPool
  }
  self.dests = self.dests || []
  self.__isRequestRequest = true

  // Protect against double callback
  if (!self._callback && self.callback) {
    self._callback = self.callback
    self.callback = function (error, response, body) {
      if (self._callbackCalled) {
        return // Print a warning maybe?
      }
      self._callbackCalled = true
      self._callback(error, response, body, self._debug)
    }
    self.on('error', self.callback.bind())
    self.on('complete', self.callback.bind(self, null))
  }

  // People use this property instead all the time, so support it
  if (!self.uri && self.url) {
    self.uri = self.url
    delete self.url
  }

  // If there's a baseUrl, then use it as the base URL (i.e. uri must be
  // specified as a relative path and is appended to baseUrl).
  if (self.baseUrl) {
    if (typeof self.baseUrl !== 'string') {
      return self.emit('error', new Error('options.baseUrl must be a string'))
    }

    if (typeof self.uri !== 'string') {
      return self.emit('error', new Error('options.uri must be a string when using options.baseUrl'))
    }

    if (self.uri.indexOf('//') === 0 || self.uri.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//)) {
      return self.emit('error', new Error('options.uri must be a path when using options.baseUrl'))
    }

    // Handle all cases to make sure that there's only one slash between
    // baseUrl and uri.
    var baseUrlEndsWithSlash = self.baseUrl.lastIndexOf('/') === self.baseUrl.length - 1
    var uriStartsWithSlash = self.uri.indexOf('/') === 0

    if (baseUrlEndsWithSlash && uriStartsWithSlash) {
      self.uri = self.baseUrl + self.uri.slice(1)
    } else if (baseUrlEndsWithSlash || uriStartsWithSlash) {
      self.uri = self.baseUrl + self.uri
    } else if (self.uri === '') {
      self.uri = self.baseUrl
    } else {
      self.uri = self.baseUrl + '/' + self.uri
    }
    delete self.baseUrl
  }

  // A URI is needed by this point, emit error if we haven't been able to get one
  if (!self.uri) {
    return self.emit('error', new Error('options.uri is a required argument'))
  }

  // If a string URI/URL was given, parse it into a URL object
  if (typeof self.uri === 'string') {
    self.uri = self.urlParser.parse(self.uri)
  }

  // Some URL objects are not from a URL parsed string and need href added
  if (!self.uri.href) {
    self.uri.href = url.format(self.uri)
  }

  // DEPRECATED: Warning for users of the old Unix Sockets URL Scheme
  if (self.uri.protocol === 'unix:') {
    return self.emit('error', new Error('`unix://` URL scheme is no longer supported. Please use the format `http://unix:SOCKET:PATH`'))
  }

  // Support Unix Sockets
  if (self.uri.host === 'unix') {
    self.enableUnixSocket()
  }

  if (self.strictSSL === false) {
    self.rejectUnauthorized = false
  }

  if (!self.uri.pathname) { self.uri.pathname = '/' }

  if (!(self.uri.host || (self.uri.hostname && self.uri.port)) && !self.uri.isUnix) {
    // Invalid URI: it may generate lot of bad errors, like 'TypeError: Cannot call method `indexOf` of undefined' in CookieJar
    // Detect and reject it as soon as possible
    var faultyUri = url.format(self.uri)
    var message = 'Invalid URI "' + faultyUri + '"'
    if (Object.keys(options).length === 0) {
      // No option ? This can be the sign of a redirect
      // As this is a case where the user cannot do anything (they didn't call request directly with this URL)
      // they should be warned that it can be caused by a redirection (can save some hair)
      message += '. This can be caused by a crappy redirection.'
    }
    // This error was fatal
    self.abort()
    return self.emit('error', new Error(message))
  }

  if (!self.hasOwnProperty('proxy')) {
    self.proxy = getProxyFromURI(self.uri)
  }

  if (typeof self.proxy === 'string') {
    self.proxy = self.urlParser.parse(self.proxy)

    if (self.proxy.auth) {
      self.proxy.auth = self._qs.unescape(self.proxy.auth)
    }
  }

  self.tunnel = self._tunnel.isEnabled()
  if (self.proxy) {
    self._tunnel.setup(options)
  }

  self._redirect.onRequest(options)

  // Add `Host` header if not defined already
  self.setHost = (self.setHost === undefined || Boolean(self.setHost))
  if (!self.hasHeader('host') && self.setHost) {
    var hostHeaderName = self.originalHostHeaderName || 'Host'
    self.setHeader(hostHeaderName, self.uri.host)
    // Drop :port suffix from Host header if known protocol.
    if (self.uri.port) {
      if ((self.uri.port === '80' && self.uri.protocol === 'http:') ||
          (self.uri.port === '443' && self.uri.protocol === 'https:')) {
        self.setHeader(hostHeaderName, self.uri.hostname)
      }
    }
  }

  if (!self.uri.port) {
    if (self.uri.protocol === 'http:') { self.uri.port = 80 } else if (self.uri.protocol === 'https:') { self.uri.port = 443 }
  }

  if (self.proxy && !self.tunnel) {
    self.port = self.proxy.port
    self.host = self.proxy.hostname
  } else {
    self.port = self.uri.port
    self.host = self.uri.hostname
  }

  if (options.form) {
    self.form(options.form)
  }

  if (options.formData) {
    var formData = options.formData
    var requestForm = self.form()
    for (var i = 0, ii = formData.length; i < ii; i++) {
      var formParam = formData[i]
      if (!formParam) { continue }
      if (formParam.options) {
        requestForm.append(formParam.key, formParam.value, formParam.options)
      } else {
        requestForm.append(formParam.key, formParam.value)
      }
    }
  }

  if (options.qs) {
    self.qs(options.qs)
  }

  if (self.uri.path) {
    self.path = self.uri.path
  } else {
    self.path = self.uri.pathname + (self.uri.search || '')
  }

  if (self.path.length === 0) {
    self.path = '/'
  }

  // Auth must happen last in case signing is dependent on other headers
  if (options.aws) {
    self.aws(options.aws)
  }

  if (options.hawk) {
    self.hawk(options.hawk)
  }

  if (options.httpSignature) {
    self.httpSignature(options.httpSignature)
  }

  if (options.auth) {
    if (Object.prototype.hasOwnProperty.call(options.auth, 'username')) {
      options.auth.user = options.auth.username
    }
    if (Object.prototype.hasOwnProperty.call(options.auth, 'password')) {
      options.auth.pass = options.auth.password
    }

    self.auth(
      options.auth.user,
      options.auth.pass,
      options.auth.sendImmediately,
      options.auth.bearer
    )
  }

  if (!self.hasHeader('accept-encoding')) {
    var acceptEncoding = ''

    self.gzip && (acceptEncoding += 'gzip, deflate')

    if (self.brotli) {
      acceptEncoding && (acceptEncoding += ', ')
      acceptEncoding += 'br'
    }

    acceptEncoding && self.setHeader('Accept-Encoding', acceptEncoding)
  }

  if (self.uri.auth && !self.hasHeader('authorization')) {
    var uriAuthPieces = self.uri.auth.split(':').map(function (item) { return self._qs.unescape(item) })
    self.auth(uriAuthPieces[0], uriAuthPieces.slice(1).join(':'), true)
  }

  if (!self.tunnel && self.proxy && self.proxy.auth && !self.hasHeader('proxy-authorization')) {
    self.setHeader('Proxy-Authorization', 'Basic ' + toBase64(self.proxy.auth))
  }

  if (self.proxy && !self.tunnel) {
    self.path = (self.uri.protocol + '//' + self.uri.host + self.path)
  }

  if (options.json) {
    self.json(options.json)
  }
  if (options.multipart) {
    self.multipart(options.multipart)
  }

  // enable timings if verbose is true
  if (options.time || options.verbose) {
    self.timing = true

    // NOTE: elapsedTime is deprecated in favor of .timings
    self.elapsedTime = self.elapsedTime || 0
  }

  if (options.verbose) {
    self.verbose = true
  }

  if (typeof options.maxResponseSize === 'number') {
    self.maxResponseSize = options.maxResponseSize
  }

  function setContentLength () {
    if (isTypedArray(self.body)) {
      self.body = Buffer.from(self.body)
    }

    if (!self.hasHeader('content-length')) {
      var length
      if (typeof self.body === 'string') {
        length = Buffer.byteLength(self.body)
      } else if (Array.isArray(self.body)) {
        length = self.body.reduce(function (a, b) { return a + b.length }, 0)
      } else {
        length = self.body.length
      }

      if (length) {
        self.setHeader('Content-Length', length)
      } else {
        self.emit('error', new Error('Argument error, options.body.'))
      }
    }
  }

  if (self.body && !isstream(self.body)) {
    setContentLength()
  }

  if (options.oauth) {
    self.oauth(options.oauth)
  } else if (self._oauth.params && self.hasHeader('authorization')) {
    self.oauth(self._oauth.params)
  }

  var protocol = self.proxy && !self.tunnel ? self.proxy.protocol : self.uri.protocol
  var defaultModules = {'http:': { http2: http, http1: http, auto: http }, 'https:': { http1: https, http2: http2, auto: autohttp2 }}
  var httpModules = self.httpModules || {}

  // If user defines httpModules, respect if they have different httpModules for different http versions, else use the tls specific http module
  // If the user defines nothing, revert to default modules
  self.httpModule = (httpModules[protocol] && httpModules[protocol][self.protocolVersion]) || httpModules[protocol] || (defaultModules[protocol] && defaultModules[protocol][self.protocolVersion])

  if (httpModules[protocol] && !(httpModules[protocol][options.protocolVersion])) {
    // If the user is only specifying https/http modules, revert to http1
    self.protocolVersion = 'http1'
  }

  if (!self.httpModule) {
    return self.emit('error', new Error('Invalid protocol: ' + protocol))
  }

  if (options.ca) {
    self.ca = options.ca
  }

  // prefer common self.agent if exists
  if (self.agents && !self.agent) {
    var agent = protocol === 'http:' ? self.agents.http : self.agents.https
    if (agent) {
      if (agent.agentClass || agent.agentOptions) {
        options.agentClass = agent.agentClass || options.agentClass
        options.agentOptions = agent.agentOptions || options.agentOptions
      } else {
        self.agent = agent
      }
    }
  }

  if (!self.agent) {
    if (options.agentOptions) {
      self.agentOptions = options.agentOptions
    }

    if (options.agentClass) {
      self.agentClass = options.agentClass
    } else if (options.forever) {
      var v = version()
      // use ForeverAgent in node 0.10- only
      if (v.major === 0 && v.minor <= 10) {
        self.agentClass = protocol === 'http:' ? ForeverAgent : ForeverAgent.SSL
      } else {
        self.agentClass = self.httpModule.Agent
        self.agentOptions = self.agentOptions || {}
        self.agentOptions.keepAlive = true
      }
    } else {
      self.agentClass = self.httpModule.Agent
    }
  }

  if (self.pool === false) {
    self.agent = false
  } else {
    try {
      self.agent = self.agent || self.getNewAgent({agentIdleTimeout: options.agentIdleTimeout})
    } catch (error) {
      // tls.createSecureContext() throws on bad options
      return self.emit('error', error)
    }
  }

  self.on('pipe', function (src) {
    if (self.ntick && self._started) {
      self.emit('error', new Error('You cannot pipe to this stream after the outbound request has started.'))
    }
    self.src = src
    if (isReadStream(src)) {
      if (!self.hasHeader('content-type')) {
        // @note fallback to 'application/octet-stream' if mime.lookup returns `false`
        self.setHeader('Content-Type', mime.lookup(src.path) || 'application/octet-stream')
      }
    } else {
      if (src.headers) {
        for (var i in src.headers) {
          if (!self.hasHeader(i)) {
            self.setHeader(i, src.headers[i])
          }
        }
      }
      if (self._json && !self.hasHeader('content-type')) {
        self.setHeader('Content-Type', 'application/json')
      }
      if (src.method && !self.explicitMethod) {
        self.method = src.method
      }
    }

    // self.on('pipe', function () {
    //   console.error('You have already piped to this stream. Pipeing twice is likely to break the request.')
    // })
  })

  defer(function () {
    if (self._aborted) {
      return
    }

    var end = function () {
      if (self._form) {
        if (!self._auth.hasAuth || (self._auth.hasAuth && self._auth.sentAuth)) {
          try {
            self._form.pipe(self)
          } catch (err) {
            self.abort()
            options.callback && options.callback(err)
            return
          }
        }
      }
      if (self._multipart && self._multipart.chunked) {
        self._multipart.body.pipe(self)
      }
      if (self.body) {
        if (isstream(self.body)) {
          if (self.hasHeader('content-length')) {
            self.body.pipe(self)
          } else { // certain servers require content-length to function. we try to pre-detect if possible
            streamLength(self.body, {}, function (err, len) {
              if (!(err || self._started || self.hasHeader('content-length') || len === null || len < 0)) {
                self.setHeader('Content-Length', len)
              }
              self.body.pipe(self)
            })
          }
        } else {
          setContentLength()
          if (Array.isArray(self.body)) {
            self.body.forEach(function (part) {
              self.write(part)
            })
          } else {
            self.write(self.body)
          }
          self.end()
        }
      } else if (self.requestBodyStream) {
        console.warn('options.requestBodyStream is deprecated, please pass the request object to stream.pipe.')
        self.requestBodyStream.pipe(self)
      } else if (!self.src) {
        if ((self._auth.hasAuth && !self._auth.sentAuth) || self.hasHeader('content-length')) {
          self.end()
          return
        }
        switch (self.method) {
          case 'GET':
          case 'HEAD':
          case 'TRACE':
          case 'DELETE':
          case 'CONNECT':
          case 'OPTIONS':
          case undefined:
            // @note this behavior is same as Node.js
            break
          default:
            self.setHeader('Content-Length', 0)
            break
        }
        self.end()
      }
    }

    self.jar(self._jar || options.jar, function () {
      if (self._form && !self.hasHeader('content-length')) {
        // Before ending the request, we had to compute the length of the whole form, asyncly
        self._form.getLength(function (err, length) {
          if (!err && !isNaN(length)) {
            self.setHeader('Content-Length', length)
          }
          end()
        })
      } else {
        end()
      }
    })

    self.ntick = true
  })
}

Request.prototype.getNewAgent = function ({agentIdleTimeout}) {
  var self = this
  var Agent = self.agentClass
  var options = {}
  if (self.agentOptions) {
    for (var i in self.agentOptions) {
      options[i] = self.agentOptions[i]
    }
  }
  if (self.ca) {
    options.ca = self.ca
  }
  if (self.extraCA) {
    options.extraCA = self.extraCA
  }
  if (self.ciphers) {
    options.ciphers = self.ciphers
  }
  if (self.secureProtocol) {
    options.secureProtocol = self.secureProtocol
  }
  if (self.secureOptions) {
    options.secureOptions = self.secureOptions
  }
  if (typeof self.rejectUnauthorized !== 'undefined') {
    options.rejectUnauthorized = self.rejectUnauthorized
  }

  if (self.cert && self.key) {
    options.key = self.key
    options.cert = self.cert
  }

  if (self.pfx) {
    options.pfx = self.pfx
  }

  if (self.passphrase) {
    options.passphrase = self.passphrase
  }

  var poolKey = ''

  // different types of agents are in different pools
  if (Agent !== self.httpModule.Agent) {
    poolKey += Agent.name
  }

  // ca option is only relevant if proxy or destination are https
  var proxy = self.proxy
  if (typeof proxy === 'string') {
    proxy = self.urlParser.parse(proxy)
  }
  var isHttps = (proxy && proxy.protocol === 'https:') || this.uri.protocol === 'https:'

  if (isHttps) {
    if (options.ca) {
      if (poolKey) {
        poolKey += ':'
      }
      poolKey += options.ca
    }

    // only add when NodeExtraCACerts is enabled
    if (options.extraCA) {
      if (poolKey) {
        poolKey += ':'
      }
      poolKey += options.extraCA

      // Create a new secure context to add the extra CA
      var secureContext = tls.createSecureContext(options)
      secureContext.context.addCACert(options.extraCA)
      options.secureContext = secureContext
    }

    if (typeof options.rejectUnauthorized !== 'undefined') {
      if (poolKey) {
        poolKey += ':'
      }
      poolKey += options.rejectUnauthorized
    }

    if (options.cert) {
      if (poolKey) {
        poolKey += ':'
      }
      poolKey += options.cert.toString('ascii') + options.key.toString('ascii')
    }

    if (options.pfx) {
      if (poolKey) {
        poolKey += ':'
      }
      poolKey += options.pfx.toString('ascii')
    }

    if (options.passphrase) {
      if (poolKey) {
        poolKey += ':'
      }
      poolKey += options.passphrase
    }

    if (options.ciphers) {
      if (poolKey) {
        poolKey += ':'
      }
      poolKey += options.ciphers
    }

    if (options.secureProtocol) {
      if (poolKey) {
        poolKey += ':'
      }
      poolKey += options.secureProtocol
    }

    if (options.secureOptions) {
      if (poolKey) {
        poolKey += ':'
      }
      poolKey += options.secureOptions
    }
  }

  if (self.pool === globalPool && !poolKey && Object.keys(options).length === 0 && self.httpModule.globalAgent && typeof agentIdleTimeout !== 'number') {
    // not doing anything special.  Use the globalAgent
    return self.httpModule.globalAgent
  }

  // we're using a stored agent.  Make sure it's protocol-specific
  poolKey = self.protocolVersion + ':' + self.uri.protocol + poolKey

  let agent = self.pool[poolKey]

  // generate a new agent for this setting if none yet exists
  if (!agent || (typeof agentIdleTimeout === 'number' && (agent.lastUsedAt || 0) + agentIdleTimeout < Date.now())) {
    agent = self.pool[poolKey] = new Agent(options)
    // properly set maxSockets on new agents
    if (self.pool.maxSockets) {
      self.pool[poolKey].maxSockets = self.pool.maxSockets
    }
  }

  agent.lastUsedAt = Date.now()
  return agent
}

Request.prototype.start = function () {
  // start() is called once we are ready to send the outgoing HTTP request.
  // this is usually called on the first write(), end() or on nextTick()
  var self = this

  if (self.timing) {
    // All timings will be relative to this request's startTime.  In order to do this,
    // we need to capture the wall-clock start time (via Date), immediately followed
    // by the high-resolution timer (via now()).  While these two won't be set
    // at the _exact_ same time, they should be close enough to be able to calculate
    // high-resolution, monotonically non-decreasing timestamps relative to startTime.
    var startTime = new Date().getTime()
    var startTimeNow = now()
  }

  if (self._aborted) {
    return
  }

  // postman: emit start event
  self.emit('start')

  self._started = true
  self.method = self.method || 'GET'
  self.href = self.uri.href

  if (self.src && self.src.stat && self.src.stat.size && !self.hasHeader('content-length')) {
    self.setHeader('Content-Length', self.src.stat.size)
  }
  if (self._aws) {
    self.aws(self._aws, true)
  }

  self._reqResInfo.request = {
    method: self.method,
    href: self.uri.href,
    headers: [],
    proxy: (self.proxy && { href: self.proxy.href }) || undefined,
    httpVersion: '1.1'
  }

  // We have a method named auth, which is completely different from the http.request
  // auth option.  If we don't remove it, we're gonna have a bad time.
  var reqOptions = copy(self)
  delete reqOptions.auth

  // Workaround for a bug in Node: https://github.com/nodejs/node/issues/8321
  if (!(self.disableUrlEncoding || self.proxy || self.uri.isUnix)) {
    try {
      extend(reqOptions, urlParse(self.uri.href))
    } catch (e) { } // nothing to do if urlParse fails, "extend" never throws an error.
  }

  debug('make request', self.uri.href)

  // node v6.8.0 now supports a `timeout` value in `http.request()`, but we
  // should delete it for now since we handle timeouts manually for better
  // consistency with node versions before v6.8.0
  delete reqOptions.timeout

  try {
    self.req = self.httpModule.request(reqOptions)

    // Remove blacklisted headers from the request instance.
    // @note don't check for `hasHeader` because headers like `connection`,
    // 'content-length', 'transfer-encoding' etc. are added at the very end
    // and `removeHeader` updates the Node.js internal state which makes sure
    // these headers are not added.
    if (Array.isArray(self.blacklistHeaders) && self.blacklistHeaders.length) {
      self.blacklistHeaders.forEach(function (header) {
        self.req.removeHeader(header)
        // also remove from the `self` for the consistency
        self.removeHeader(header)
      })
    }
  } catch (err) {
    self.emit('error', err)
    return
  }

  if (self.timing) {
    self.startTime = startTime
    self.startTimeNow = startTimeNow

    // Timing values will all be relative to startTime (by comparing to startTimeNow
    // so we have an accurate clock)
    self.timings = {}
  }

  var timeout
  if (self.timeout && !self.timeoutTimer) {
    if (self.timeout < 0) {
      timeout = 0
    } else if (typeof self.timeout === 'number' && isFinite(self.timeout)) {
      timeout = self.timeout
    }
  }

  self.req.on('response', self.onRequestResponse.bind(self))
  self.req.on('error', self.onRequestError.bind(self))
  self.req.on('drain', function () {
    self.emit('drain')
  })

  self.req.on('socket', function (socket) {
    if (self.verbose) {
      // The reused socket holds all the session data which was injected in
      // during the first connection. This is done because events like
      // `lookup`, `connect` & `secureConnect` will not be triggered for a
      // reused socket and debug information will be lost for that request.
      var reusedSocket = Boolean(socket.__SESSION_ID && socket.__SESSION_DATA)

      if (!reusedSocket) {
        socket.__SESSION_ID = uuid()
        socket.__SESSION_DATA = {}
      }

      // @note make sure you don't serialize this object to avoid memory leak
      self._reqResInfo.session = {
        id: socket.__SESSION_ID,
        reused: reusedSocket,
        data: socket.__SESSION_DATA
      }
    }

    // `._connecting` was the old property which was made public in node v6.1.0
    var isConnecting = socket._connecting || socket.connecting
    if (self.timing) {
      self.timings.socket = now() - self.startTimeNow

      if (isConnecting) {
        var onLookupTiming = function () {
          self.timings.lookup = now() - self.startTimeNow
        }

        var onConnectTiming = function () {
          self.timings.connect = now() - self.startTimeNow

          if (self.verbose) {
            socket.__SESSION_DATA.addresses = {
              // local address
              // @note there's no `socket.localFamily` but `.address` method
              // returns same output as of remote.
              local: (typeof socket.address === 'function') && socket.address(),

              // remote address
              remote: {
                address: socket.remoteAddress,
                family: socket.remoteFamily,
                port: socket.remotePort
              }
            }
          }
        }

        var onSecureConnectTiming = function () {
          self.timings.secureConnect = now() - self.startTimeNow

          if (self.verbose) {
            socket.__SESSION_DATA.tls = {
              // true if the session was reused
              reused: (typeof socket.isSessionReused === 'function') && socket.isSessionReused(),

              // true if the peer certificate was signed by one of the CAs specified
              authorized: socket.authorized,

              // reason why the peer's certificate was not been verified
              authorizationError: socket.authorizationError,

              // negotiated cipher name
              cipher: (typeof socket.getCipher === 'function') && socket.getCipher(),

              // negotiated SSL/TLS protocol version
              // @note Node >= v5.7.0
              protocol: (typeof socket.getProtocol === 'function') && socket.getProtocol(),

              // type, name, and size of parameter of an ephemeral key exchange
              // @note Node >= v5.0.0
              ephemeralKeyInfo: (typeof socket.getEphemeralKeyInfo === 'function') && socket.getEphemeralKeyInfo()
            }

            // peer certificate information
            // @note if session is reused, all certificate information is
            // stripped from the socket (returns {}).
            // Refer: https://github.com/nodejs/node/issues/3940
            var peerCert = (typeof socket.getPeerCertificate === 'function') && (socket.getPeerCertificate() || {})

            socket.__SESSION_DATA.tls.peerCertificate = {
              subject: peerCert.subject && {
                country: peerCert.subject.C,
                stateOrProvince: peerCert.subject.ST,
                locality: peerCert.subject.L,
                organization: peerCert.subject.O,
                organizationalUnit: peerCert.subject.OU,
                commonName: peerCert.subject.CN,
                alternativeNames: peerCert.subjectaltname
              },
              issuer: peerCert.issuer && {
                country: peerCert.issuer.C,
                stateOrProvince: peerCert.issuer.ST,
                locality: peerCert.issuer.L,
                organization: peerCert.issuer.O,
                organizationalUnit: peerCert.issuer.OU,
                commonName: peerCert.issuer.CN
              },
              validFrom: peerCert.valid_from,
              validTo: peerCert.valid_to,
              fingerprint: peerCert.fingerprint,
              serialNumber: peerCert.serialNumber
            }
          }
        }

        socket.once('lookup', onLookupTiming)
        socket.once('connect', onConnectTiming)
        socket.once('secureConnect', onSecureConnectTiming)

        // clean up timing event listeners if needed on error
        self.req.once('error', function () {
          // Swallow ERR_HTTP2_SOCKET_UNBOUND error when removing listeners in case of error.
          // This needs to be done since http2 ClientSession disassociates the underlying socket from the session before emitting the error event
          try {
            socket.removeListener('lookup', onLookupTiming)
            socket.removeListener('connect', onConnectTiming)
          } catch (err) {
            if (err.code !== 'ERR_HTTP2_SOCKET_UNBOUND') {
              throw err
            }
          }
        })
      }
    }

    var setReqTimeout = function () {
      // This timeout sets the amount of time to wait *between* bytes sent
      // from the server once connected.
      //
      // In particular, it's useful for erroring if the server fails to send
      // data halfway through streaming a response.
      self.req.setTimeout(timeout, function () {
        if (self.req) {
          self.abort()
          var e = new Error('ESOCKETTIMEDOUT')
          e.code = 'ESOCKETTIMEDOUT'
          e.connect = false
          self.emit('error', e)
        }
      })
    }
    if (timeout !== undefined) {
      // Only start the connection timer if we're actually connecting a new
      // socket, otherwise if we're already connected (because this is a
      // keep-alive connection) do not bother. This is important since we won't
      // get a 'connect' event for an already connected socket.
      if (isConnecting) {
        var onReqSockConnect = function () {
          socket.removeListener('connect', onReqSockConnect)
          self.clearTimeout()
          setReqTimeout()
        }

        socket.on('connect', onReqSockConnect)

        self.req.on('error', function (err) { // eslint-disable-line handle-callback-err
          // Swallow ERR_HTTP2_SOCKET_UNBOUND error when removing listeners in case of error.
          // This needs to be done since http2 ClientSession disassociates the underlying socket from the session before emitting the error event
          try {
            socket.removeListener('connect', onReqSockConnect)
          } catch (err) {
            if (err.code !== 'ERR_HTTP2_SOCKET_UNBOUND') {
              throw err
            }
          }
        })

        // Set a timeout in memory - this block will throw if the server takes more
        // than `timeout` to write the HTTP status and headers (corresponding to
        // the on('response') event on the client). NB: this measures wall-clock
        // time, not the time between bytes sent by the server.
        self.timeoutTimer = setTimeout(function () {
          socket.removeListener('connect', onReqSockConnect)
          self.abort()
          var e = new Error('ETIMEDOUT')
          e.code = 'ETIMEDOUT'
          e.connect = true
          self.emit('error', e)
        }, timeout)
      } else {
        // We're already connected
        setReqTimeout()
      }
    }
    self.emit('socket', socket)
  })

  self.emit('request', self.req)
}

Request.prototype.onRequestError = function (error) {
  var self = this
  if (self._aborted) {
    return
  }
  if (self.req && self.req._reusedSocket && error.code === 'ECONNRESET' &&
    self.agent.addRequestNoreuse) {
    self.agent = {addRequest: self.agent.addRequestNoreuse.bind(self.agent)}
    self.start()
    self.req.end()
    return
  }
  self.clearTimeout()
  self.emit('error', error)
}

Request.prototype.onRequestResponse = function (response) {
  var self = this
  // De-referencing self.startTimeNow to prevent race condition during redirects
  // Race-condition:
  // 30x-url: Request start (self.startTimeNow initialized (self.start()))
  // Redirect header to 200 request received
  // 200-url: Request start (self.startTimeNow re-initialized, old value overwritten (redirect.js -> request.init() -> self.start()))
  // 30x-url: end event received, timing calculated using new self.startTimeNow (incorrect)
  //
  // This must've been happening with http/1.1 as well when using keep-alive, but there were no tests to catch this.
  // Was highlighted with http/2 where connections are reused by default
  // Does not show up in http/1.x tests due to delays involving socket establishment
  //
  // New flow
  // 30x-url: Request start (self.startTimeNow initialized)
  // Redirect header to 200 request received
  // 200-url: Request start (self.startTimeNow re-initialized, old value overwritten)
  // 30x-url: end event received, timing calculated using requestSegmentStartTime (correct)
  const requestSegmentStartTime = self.startTimeNow

  if (self.timing) {
    self.timings.response = now() - requestSegmentStartTime
  }

  debug('onRequestResponse', self.uri.href, response.statusCode, response.headers)
  response.on('end', function () {
    if (self.timing) {
      self.timings.end = now() - requestSegmentStartTime
      response.timingStart = self.startTime
      response.timingStartTimer = requestSegmentStartTime

      // fill in the blanks for any periods that didn't trigger, such as
      // no lookup or connect due to keep alive
      if (!self.timings.socket) {
        self.timings.socket = 0
      }
      if (!self.timings.lookup) {
        self.timings.lookup = self.timings.socket
      }
      if (!self.timings.connect) {
        self.timings.connect = self.timings.lookup
      }
      if (!self.timings.secureConnect && self.uri.protocol === 'https:') {
        self.timings.secureConnect = self.timings.connect
      }
      if (!self.timings.response) {
        self.timings.response = self.timings.connect
      }

      debug('elapsed time', self.timings.end)

      // elapsedTime includes all redirects
      self.elapsedTime += Math.round(self.timings.end)

      // NOTE: elapsedTime is deprecated in favor of .timings
      response.elapsedTime = self.elapsedTime

      // timings is just for the final fetch
      response.timings = self.timings

      // pre-calculate phase timings as well
      response.timingPhases = {
        wait: self.timings.socket,
        dns: self.timings.lookup - self.timings.socket,
        tcp: self.timings.connect - self.timings.lookup,
        firstByte: self.timings.response - self.timings.connect,
        download: self.timings.end - self.timings.response,
        total: self.timings.end
      }

      // if secureConnect is present, add secureHandshake and update firstByte
      if (self.timings.secureConnect) {
        response.timingPhases.secureHandshake = self.timings.secureConnect - self.timings.connect
        response.timingPhases.firstByte = self.timings.response - self.timings.secureConnect
      }
    }

    debug('response end', self.uri.href, response.statusCode, response.headers)
  })

  if (self._aborted) {
    debug('aborted', self.uri.href)
    response.resume()
    return
  }

  self._reqResInfo.response = {
    statusCode: response.statusCode,
    headers: parseResponseHeaders(response.rawHeaders),
    httpVersion: response.httpVersion
  }

  // Setting this again since the actual request version that was used is found only after ALPN negotiation in case of protocolVersion: auto
  self._reqResInfo.request.httpVersion = response.httpVersion

  if (self.timing) {
    self._reqResInfo.timingStart = self.startTime
    self._reqResInfo.timingStartTimer = self.startTimeNow
    self._reqResInfo.timings = self.timings
  }

  self.response = response
  response.request = self
  response.toJSON = responseToJSON

  // XXX This is different on 0.10, because SSL is strict by default
  if (self.uri.protocol === 'https:' &&
    self.strictSSL && (!response.hasOwnProperty('socket') ||
      !response.socket.authorized)) {
    debug('strict ssl error', self.uri.href)
    var sslErr = response.hasOwnProperty('socket') ? response.socket.authorizationError : self.uri.href + ' does not support SSL'
    self.emit('error', new Error('SSL Error: ' + sslErr))
    return
  }

  // Save the original host before any redirect (if it changes, we need to
  // remove any authorization headers).  Also remember the case of the header
  // name because lots of broken servers expect Host instead of host and we
  // want the caller to be able to specify this.
  self.originalHost = self.getHeader('host')
  if (!self.originalHostHeaderName) {
    self.originalHostHeaderName = self.hasHeader('host')
  }
  if (self.setHost) {
    self.removeHeader('host')
  }
  self.clearTimeout()

  function responseHandler () {
    self._redirect.onResponse(response, function (err, followingRedirect) {
      if (!err && followingRedirect) return // Ignore the rest of the response
      if (err) self.emit('error', err)

      // Be a good stream and emit end when the response is finished.
      // Hack to emit end on close because of a core bug that never fires end
      response.once('close', function () {
        if (!self._ended) {
          self._ended = true
          self.response.emit('end')
        }
      })

      response.once('end', function () {
        self._ended = true
      })

      var noBody = function (code) {
        return (
          self.method === 'HEAD' ||
          // Informational
          (code >= 100 && code < 200) ||
          // No Content
          code === 204 ||
          // Not Modified
          code === 304
        )
      }

      var responseContent
      var downloadSizeTracker = new SizeTrackerStream()

      if ((self.gzip || self.brotli) && !noBody(response.statusCode)) {
        var contentEncoding = response.headers['content-encoding'] || 'identity'
        contentEncoding = contentEncoding.trim().toLowerCase()

        // Be more lenient with decoding compressed responses, since (very rarely)
        // servers send slightly invalid gzip responses that are still accepted
        // by common browsers.
        // Always using Z_SYNC_FLUSH is what cURL does.
        var zlibOptions = {
          flush: zlib.Z_SYNC_FLUSH,
          finishFlush: zlib.Z_SYNC_FLUSH
        }

        if (self.gzip && contentEncoding === 'gzip') {
          responseContent = zlib.createGunzip(zlibOptions)
          response.pipe(downloadSizeTracker).pipe(responseContent)
        } else if (self.gzip && contentEncoding === 'deflate') {
          responseContent = inflate.createInflate(zlibOptions)
          response.pipe(downloadSizeTracker).pipe(responseContent)
        } else if (self.brotli && contentEncoding === 'br') {
          responseContent = zlib.createBrotliDecompress()
          response.pipe(downloadSizeTracker).pipe(responseContent)
        } else {
          // Since previous versions didn't check for Content-Encoding header,
          // ignore any invalid values to preserve backwards-compatibility
          if (contentEncoding !== 'identity') {
            debug('ignoring unrecognized Content-Encoding ' + contentEncoding)
          }
          responseContent = response.pipe(downloadSizeTracker)
        }
      } else {
        responseContent = response.pipe(downloadSizeTracker)
      }

      if (self.encoding) {
        if (self.dests.length !== 0) {
          console.error('Ignoring encoding parameter as this stream is being piped to another stream which makes the encoding option invalid.')
        } else {
          responseContent.setEncoding(self.encoding)
        }
      }

      // Node by default returns the status message with `latin1` character encoding,
      // which results in characters lying outside the range of `U+0000 to U+00FF` getting truncated
      // so that they can be mapped in the given range.
      // Refer: https://nodejs.org/docs/latest-v12.x/api/buffer.html#buffer_buffers_and_character_encodings
      //
      // Exposing `statusMessageEncoding` option to make encoding type configurable.
      // This would help in correctly representing status messages belonging to range outside of `latin1`
      //
      // @note: The Regex `[^\w\s-']` is tested to prevent unnecessary computation of creating a Buffer and
      // then decoding it when the status message consists of common characters,
      // specifically belonging to the following set: [a-z, A-Z, 0-9, -, _ ', whitespace]
      // As in that case, no matter what the encoding type is used for decoding the buffer, the result would remain the same.
      //
      // @note: Providing a value in this option will result in force re-encoding of the status message
      // which may not always be intended by the server - specifically in cases where
      // server returns a status message which when encoded again with a different character encoding
      // results in some other characters.
      // For example: If the server intentionally responds with `ð\x9F\x98\x8A` as status message
      // but if the statusMessageEncoding option is set to `utf8`, then it would get converted to '😊'.
      var statusMessage = String(response.statusMessage)
      if (self.statusMessageEncoding && /[^\w\s-']/.test(statusMessage)) {
        response.statusMessage = Buffer.from(statusMessage, 'latin1').toString(self.statusMessageEncoding)
      }

      if (self._paused) {
        responseContent.pause()
      }

      self.responseContent = responseContent

      self.emit('response', response)

      self.dests.forEach(function (dest) {
        self.pipeDest(dest)
      })

      var responseThresholdEnabled = false
      var responseBytesLeft

      if (typeof self.maxResponseSize === 'number') {
        responseThresholdEnabled = true
        responseBytesLeft = self.maxResponseSize
      }

      responseContent.on('data', function (chunk) {
        if (self.timing && !self.responseStarted) {
          self.responseStartTime = (new Date()).getTime()

          // NOTE: responseStartTime is deprecated in favor of .timings
          response.responseStartTime = self.responseStartTime
        }
        // if response threshold is set, update the response bytes left to hit
        // threshold. If exceeds, abort the request.
        if (responseThresholdEnabled) {
          responseBytesLeft -= chunk.length
          if (responseBytesLeft < 0) {
            self.emit('error', new Error('Maximum response size reached'))
            self.destroy()
            self.abort()
            return
          }
        }
        self._destdata = true
        self.emit('data', chunk)
      })
      responseContent.once('end', function (chunk) {
        self._reqResInfo.response.downloadedBytes = downloadSizeTracker.size
        self.emit('end', chunk)
      })
      responseContent.on('error', function (error) {
        if (error.code === 'ECONNRESET' && error.message === 'aborted' && self.listenerCount('error') === 0) {
          // Node 16 causes aborts to emit errors if there is an error listener.
          // Without this short-circuit, it will cause unhandled exceptions since
          // there is not always an `error` listener on `self`, but there will
          // always be an `error` listener on `responseContent`.
          // @see https://github.com/nodejs/node/pull/33172
          return
        }
        self.emit('error', error)
      })
      responseContent.on('close', function () { self.emit('close') })

      if (self.callback) {
        self.readResponseBody(response)
      } else { // if no callback
        self.on('end', function () {
          if (self._aborted) {
            debug('aborted', self.uri.href)
            return
          }
          self.emit('complete', response)
        })
      }
    })
  }

  function forEachAsync (items, fn, cb) {
    !cb && (cb = function () { /* (ಠ_ಠ) */ })

    if (!(Array.isArray(items) && fn)) { return cb() }

    var index = 0
    var totalItems = items.length
    function next (err) {
      if (err || index >= totalItems) {
        return cb(err)
      }

      try {
        fn.call(items, items[index++], next)
      } catch (error) {
        return cb(error)
      }
    }

    if (!totalItems) { return cb() }

    next()
  }

  var targetCookieJar = (self._jar && self._jar.setCookie) ? self._jar : globalCookieJar
  var addCookie = function (cookie, cb) {
    // set the cookie if it's domain in the URI's domain.
    targetCookieJar.setCookie(cookie, self.uri, {ignoreError: true}, function () {
      // swallow the error, don't fail the request because of cookie jar failure
      cb()
    })
  }

  response.caseless = caseless(response.headers)

  if (response.caseless.has('set-cookie') && (!self._disableCookies)) {
    var headerName = response.caseless.has('set-cookie')
    if (Array.isArray(response.headers[headerName])) {
      forEachAsync(response.headers[headerName], addCookie, function (err) {
        if (err) { return self.emit('error', err) }

        responseHandler()
      })
    } else {
      addCookie(response.headers[headerName], responseHandler)
    }
  } else {
    responseHandler()
  }

  debug('finish init function', self.uri.href)
}

Request.prototype.readResponseBody = function (response) {
  var self = this
  debug('reading response\'s body')
  var buffers = []
  var bufferLength = 0
  var strings = []

  self.on('data', function (chunk) {
    if (!Buffer.isBuffer(chunk)) {
      strings.push(chunk)
    } else if (chunk.length) {
      bufferLength += chunk.length
      buffers.push(chunk)
    }
  })
  self.on('end', function () {
    debug('end event', self.uri.href)
    if (self._aborted) {
      debug('aborted', self.uri.href)
      // `buffer` is defined in the parent scope and used in a closure it exists for the life of the request.
      // This can lead to leaky behavior if the user retains a reference to the request object.
      buffers = []
      bufferLength = 0
      return
    }

    if (bufferLength) {
      debug('has body', self.uri.href, bufferLength)
      response.body = Buffer.concat(buffers, bufferLength)
      if (self.encoding !== null) {
        response.body = response.body.toString(self.encoding)
      }
      // `buffer` is defined in the parent scope and used in a closure it exists for the life of the Request.
      // This can lead to leaky behavior if the user retains a reference to the request object.
      buffers = []
      bufferLength = 0
    } else if (strings.length) {
      // The UTF8 BOM [0xEF,0xBB,0xBF] is converted to [0xFE,0xFF] in the JS UTC16/UCS2 representation.
      // Strip this value out when the encoding is set to 'utf8', as upstream consumers won't expect it and it breaks JSON.parse().
      if (self.encoding === 'utf8' && strings[0].length > 0 && strings[0][0] === '\uFEFF') {
        strings[0] = strings[0].substring(1)
      }
      response.body = strings.join('')
    }

    if (self._json) {
      try {
        response.body = JSON.parse(response.body, self._jsonReviver)
      } catch (e) {
        debug('invalid JSON received', self.uri.href)
      }
    }
    debug('emitting complete', self.uri.href)
    if (typeof response.body === 'undefined' && !self._json) {
      response.body = self.encoding === null ? Buffer.alloc(0) : ''
    }
    self.emit('complete', response, response.body)
  })
}

Request.prototype.abort = function () {
  var self = this
  self._aborted = true

  if (self.req) {
    self.req.abort()
  } else if (self.response) {
    self.response.destroy()
  }

  self.clearTimeout()
  self.emit('abort')
}

Request.prototype.pipeDest = function (dest) {
  var self = this
  var response = self.response
  // Called after the response is received
  if (dest.headers && !dest.headersSent) {
    if (response.caseless.has('content-type')) {
      var ctname = response.caseless.has('content-type')
      if (dest.setHeader) {
        dest.setHeader(ctname, response.headers[ctname])
      } else {
        dest.headers[ctname] = response.headers[ctname]
      }
    }

    if (response.caseless.has('content-length')) {
      var clname = response.caseless.has('content-length')
      if (dest.setHeader) {
        dest.setHeader(clname, response.headers[clname])
      } else {
        dest.headers[clname] = response.headers[clname]
      }
    }
  }
  if (dest.setHeader && !dest.headersSent) {
    for (var i in response.headers) {
      if (i.startsWith(':')) {
        // Don't set HTTP/2 pseudoheaders
        continue
      }
      // If the response content is being decoded, the Content-Encoding header
      // of the response doesn't represent the piped content, so don't pass it.
      if (!self.gzip || i !== 'content-encoding') {
        dest.setHeader(i, response.headers[i])
      }
    }
    dest.statusCode = response.statusCode
  }
  if (self.pipefilter) {
    self.pipefilter(response, dest)
  }
}

Request.prototype.qs = function (q, clobber) {
  var self = this
  var base
  if (!clobber && self.uri.query) {
    base = self._qs.parse(self.uri.query)
  } else {
    base = {}
  }

  for (var i in q) {
    base[i] = q[i]
  }

  var qs = self._qs.stringify(base)

  if (qs === '') {
    return self
  }

  self.uri = self.urlParser.parse(self.uri.href.split('?')[0] + '?' + qs)
  self.url = self.uri
  self.path = self.uri.path

  if (self.uri.host === 'unix') {
    self.enableUnixSocket()
  }

  return self
}
Request.prototype.form = function (form) {
  var self = this
  var contentType = self.getHeader('content-type')
  var overrideInvalidContentType = contentType ? !self.allowContentTypeOverride : true
  if (form) {
    if (overrideInvalidContentType && !/^application\/x-www-form-urlencoded\b/.test(contentType)) {
      self.setHeader('Content-Type', 'application/x-www-form-urlencoded')
    }
    self.body = (typeof form === 'string')
      ? self._qs.rfc3986(form.toString('utf8'))
      : self._qs.stringify(form).toString('utf8')
    return self
  }
  // form-data
  var contentTypeMatch = contentType && contentType.match &&
    contentType.match(/^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;]+))/)
  var boundary = contentTypeMatch && (contentTypeMatch[1] || contentTypeMatch[2])
  // create form-data object
  // set custom boundary if present in content-type else auto-generate
  self._form = new FormData({ _boundary: boundary })
  self._form.on('error', function (err) {
    err.message = 'form-data: ' + err.message
    self.emit('error', err)
    self.abort()
  })
  if (overrideInvalidContentType && !contentTypeMatch) {
    // overrides invalid or missing content-type
    self.setHeader('Content-Type', 'multipart/form-data; boundary=' + self._form.getBoundary())
  }
  return self._form
}
Request.prototype.multipart = function (multipart) {
  var self = this

  self._multipart.onRequest(multipart)

  if (!self._multipart.chunked) {
    self.body = self._multipart.body
  }

  return self
}
Request.prototype.json = function (val) {
  var self = this

  if (!self.hasHeader('accept')) {
    self.setHeader('Accept', 'application/json')
  }

  if (typeof self.jsonReplacer === 'function') {
    self._jsonReplacer = self.jsonReplacer
  }

  self._json = true
  if (typeof val === 'boolean') {
    if (self.body !== undefined) {
      if (!/^application\/x-www-form-urlencoded\b/.test(self.getHeader('content-type'))) {
        self.body = safeStringify(self.body, self._jsonReplacer)
      } else {
        self.body = self._qs.rfc3986(self.body)
      }
      if (!self.hasHeader('content-type')) {
        self.setHeader('Content-Type', 'application/json')
      }
    }
  } else {
    self.body = safeStringify(val, self._jsonReplacer)
    if (!self.hasHeader('content-type')) {
      self.setHeader('Content-Type', 'application/json')
    }
  }

  if (typeof self.jsonReviver === 'function') {
    self._jsonReviver = self.jsonReviver
  }

  return self
}
Request.prototype.getHeader = function (name, headers) {
  var self = this
  var result, re, match
  if (!headers) {
    headers = self.headers
  }
  Object.keys(headers).forEach(function (key) {
    if (key.length !== name.length) {
      return
    }
    re = new RegExp(name, 'i')
    match = key.match(re)
    if (match) {
      result = headers[key]
    }
  })
  return result
}
Request.prototype.enableUnixSocket = function () {
  // Get the socket & request paths from the URL
  var unixParts = this.uri.path.split(':')
  var host = unixParts[0]
  var path = unixParts[1]
  // Apply unix properties to request
  this.socketPath = host
  this.uri.pathname = path
  this.uri.path = path
  this.uri.host = host
  this.uri.hostname = host
  this.uri.isUnix = true
}

Request.prototype.auth = function (user, pass, sendImmediately, bearer) {
  var self = this

  self._auth.onRequest(user, pass, sendImmediately, bearer)

  return self
}
Request.prototype.aws = function (opts, now) {
  var self = this

  if (!now) {
    self._aws = opts
    return self
  }

  if (opts.sign_version === 4 || opts.sign_version === '4') {
    // use aws4
    var options = {
      host: self.uri.host,
      path: self.uri.path,
      method: self.method,
      headers: self.headers,
      body: self.body
    }
    if (opts.service) {
      options.service = opts.service
    }
    var signRes = aws4.sign(options, {
      accessKeyId: opts.key,
      secretAccessKey: opts.secret,
      sessionToken: opts.session
    })
    self.setHeader('Authorization', signRes.headers.Authorization)
    self.setHeader('X-Amz-Date', signRes.headers['X-Amz-Date'])
    if (signRes.headers['X-Amz-Security-Token']) {
      self.setHeader('X-Amz-Security-Token', signRes.headers['X-Amz-Security-Token'])
    }
  } else {
    // default: use aws-sign2
    var date = new Date()
    self.setHeader('Date', date.toUTCString())
    var auth = {
      key: opts.key,
      secret: opts.secret,
      verb: self.method.toUpperCase(),
      date: date,
      contentType: self.getHeader('content-type') || '',
      md5: self.getHeader('content-md5') || '',
      amazonHeaders: aws2.canonicalizeHeaders(self.headers)
    }
    var path = self.uri.path
    if (opts.bucket && path) {
      auth.resource = '/' + opts.bucket + path
    } else if (opts.bucket && !path) {
      auth.resource = '/' + opts.bucket
    } else if (!opts.bucket && path) {
      auth.resource = path
    } else if (!opts.bucket && !path) {
      auth.resource = '/'
    }
    auth.resource = aws2.canonicalizeResource(auth.resource)
    self.setHeader('Authorization', aws2.authorization(auth))
  }

  return self
}
Request.prototype.httpSignature = function (opts) {
  var self = this
  httpSignature.signRequest({
    getHeader: function (header) {
      return self.getHeader(header, self.headers)
    },
    setHeader: function (header, value) {
      self.setHeader(header, value)
    },
    method: self.method,
    path: self.path
  }, opts)
  debug('httpSignature authorization', self.getHeader('authorization'))

  return self
}
Request.prototype.hawk = function (opts) {
  var self = this
  self.setHeader('Authorization', hawk.header(self.uri, self.method, opts))
}
Request.prototype.oauth = function (_oauth) {
  var self = this

  self._oauth.onRequest(_oauth)

  return self
}

Request.prototype.jar = function (jar, cb) {
  var self = this
  self._jar = jar

  if (!jar) {
    // disable cookies
    self._disableCookies = true
    return cb()
  }

  if (self._redirect.redirectsFollowed === 0) {
    self.originalCookieHeader = self.getHeader('cookie')
  }

  var targetCookieJar = jar.getCookieString ? jar : globalCookieJar
  // fetch cookie in the Specified host
  targetCookieJar.getCookieString(self.uri, function (err, cookies) {
    if (err) { return cb() }

    // if need cookie and cookie is not empty
    if (cookies && cookies.length) {
      if (self.originalCookieHeader) {
        if (Array.isArray(self.originalCookieHeader)) {
          self.originalCookieHeader = self.originalCookieHeader.join('; ')
        }
        // Don't overwrite existing Cookie header
        self.setHeader('Cookie', self.originalCookieHeader + '; ' + cookies)
      } else {
        self.setHeader('Cookie', cookies)
      }
    }

    cb()
  })
}

// Stream API
Request.prototype.pipe = function (dest, opts) {
  var self = this

  if (self.response) {
    if (self._destdata) {
      self.emit('error', new Error('You cannot pipe after data has been emitted from the response.'))
    } else if (self._ended) {
      self.emit('error', new Error('You cannot pipe after the response has been ended.'))
    } else {
      stream.Stream.prototype.pipe.call(self, dest, opts)
      self.pipeDest(dest)
      return dest
    }
  } else {
    self.dests.push(dest)
    stream.Stream.prototype.pipe.call(self, dest, opts)
    return dest
  }
}
Request.prototype.write = function () {
  var self = this
  if (self._aborted) { return }

  if (!self._started) {
    self.start()
  }
  if (self.req) {
    return self.req.write.apply(self.req, arguments)
  }
}
Request.prototype.end = function (chunk) {
  var self = this
  if (self._aborted) { return }

  if (chunk) {
    self.write(chunk)
  }
  if (!self._started) {
    self.start()
  }
  if (self.req) {
    self.req.end()

    // Reference to request, so if _reqResInfo is updated (in case of redirects), we still can update the headers
    const request = self._reqResInfo.request
    Promise.resolve(self.req._header).then(function (header) {
      if (!header) {
        request.headers = []
        return
      }
      request.headers = parseRequestHeaders(header)
    })
  }
}
Request.prototype.pause = function () {
  var self = this
  if (!self.responseContent) {
    self._paused = true
  } else {
    self.responseContent.pause.apply(self.responseContent, arguments)
  }
}
Request.prototype.resume = function () {
  var self = this
  if (!self.responseContent) {
    self._paused = false
  } else {
    self.responseContent.resume.apply(self.responseContent, arguments)
  }
}
Request.prototype.destroy = function () {
  var self = this
  this.clearTimeout()
  if (!self._ended) {
    self.end()
  } else if (self.response) {
    self.response.destroy()
  }
}

Request.prototype.clearTimeout = function () {
  if (this.timeoutTimer) {
    clearTimeout(this.timeoutTimer)
    this.timeoutTimer = null
  }
}

Request.defaultProxyHeaderWhiteList =
  Tunnel.defaultProxyHeaderWhiteList.slice()

Request.defaultProxyHeaderExclusiveList =
  Tunnel.defaultProxyHeaderExclusiveList.slice()

// Exports

Request.prototype.toJSON = requestToJSON
module.exports = Request
