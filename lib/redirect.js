'use strict'

var fs = require('fs')
var isUrl = /^https?:/

function Redirect (request) {
  this.request = request
  this.followRedirect = true
  this.followRedirects = true
  this.followAllRedirects = false
  this.followOriginalHttpMethod = false
  this.followAuthorizationHeader = false
  this.allowRedirect = function () { return true }
  this.maxRedirects = 10
  this.redirects = []
  this.redirectsFollowed = 0
  this.removeRefererHeader = false
  this.allowInsecureRedirect = false
}

Redirect.prototype.onRequest = function (options) {
  var self = this

  if (options.maxRedirects !== undefined) {
    self.maxRedirects = options.maxRedirects
  }
  if (typeof options.followRedirect === 'function') {
    self.allowRedirect = options.followRedirect
  }
  if (options.followRedirect !== undefined) {
    self.followRedirects = !!options.followRedirect
  }
  if (options.followAllRedirects !== undefined) {
    self.followAllRedirects = options.followAllRedirects
  }
  if (self.followRedirects || self.followAllRedirects) {
    self.redirects = self.redirects || []
  }
  if (options.removeRefererHeader !== undefined) {
    self.removeRefererHeader = options.removeRefererHeader
  }
  if (options.followOriginalHttpMethod !== undefined) {
    self.followOriginalHttpMethod = options.followOriginalHttpMethod
  }
  if (options.followAuthorizationHeader !== undefined) {
    self.followAuthorizationHeader = options.followAuthorizationHeader
  }
  if (options.allowInsecureRedirect !== undefined) {
    self.allowInsecureRedirect = options.allowInsecureRedirect
  }
}

Redirect.prototype.redirectTo = function (response) {
  var self = this
  var request = self.request

  var redirectTo = null
  if (response.statusCode >= 300 && response.statusCode < 400 && response.caseless.has('location')) {
    var location = response.caseless.get('location')
    request.debug('redirect', location)

    if (self.followAllRedirects) {
      redirectTo = location
    } else if (self.followRedirects) {
      switch (request.method) {
        case 'PATCH':
        case 'PUT':
        case 'POST':
        case 'DELETE':
          // Do not follow redirects
          break
        default:
          redirectTo = location
          break
      }
    }
  } else if (response.statusCode === 401) {
    // retry the request with the new Authorization header value using
    // WWW-Authenticate response header.
    // https://tools.ietf.org/html/rfc7235#section-3.1
    var authHeader = request._auth.onResponse(response)
    if (authHeader) {
      request.setHeader('Authorization', authHeader)
      redirectTo = request.uri
    }
  }
  return redirectTo
}

Redirect.prototype.onResponse = function (response, callback) {
  var self = this
  var request = self.request
  var urlParser = request.urlParser
  var options = {}

  var redirectTo = self.redirectTo(response)
  if (!redirectTo) return callback(null, false)

  function processRedirect (shouldRedirect) {
    if (!shouldRedirect) return callback(null, false)
    if (typeof shouldRedirect === 'string') {
      // overridden redirect url
      request.debug('redirect overridden', redirectTo)
      redirectTo = shouldRedirect
    }

    request.debug('redirect to', redirectTo)

    // ignore any potential response body.  it cannot possibly be useful
    // to us at this point.
    // response.resume should be defined, but check anyway before calling. Workaround for browserify.
    if (response.resume) {
      response.resume()
    }

    if (self.redirectsFollowed >= self.maxRedirects) {
      return callback(new Error('Exceeded maxRedirects. Probably stuck in a redirect loop ' + request.uri.href))
    }
    self.redirectsFollowed += 1

    try {
      if (!isUrl.test(redirectTo)) {
        redirectTo = urlParser.resolve(request.uri.href, redirectTo)
      }

      var uriPrev = request.uri

      request.uri = urlParser.parse(redirectTo)
    } catch (e) {
      return callback(new Error('Failed to parse url: ' + request.uri.href))
    }

    // handle the case where we change protocol from https to http or vice versa
    if (request.uri.protocol !== uriPrev.protocol && self.allowInsecureRedirect) {
      delete request.agent
    }

    self.redirects.push({ statusCode: response.statusCode, redirectUri: redirectTo })

    // if the redirect hostname (not just port or protocol) is changed:
    //  1. remove host header, the new host will be populated on request.init
    //  2. remove authorization header, avoid authentication leak
    // @note: This is done because of security reasons, irrespective of the
    // status code or request method used.
    if (request.headers && uriPrev.hostname !== request.uri.hostname) {
      request.removeHeader('host')

      // use followAuthorizationHeader option to retain authorization header
      if (!self.followAuthorizationHeader) {
        request.removeHeader('authorization')
      }
    }

    delete request.src
    delete request.req
    delete request._started

    // Switch request method to GET
    // - if followOriginalHttpMethod is not set [OVERRIDE]
    // - or, statusCode code is not 401, 307 or 308 [STANDARD]
    // - also, remove request body for the GET redirect [STANDARD]
    // @note: when followOriginalHttpMethod is set,
    // it will always retain the request body irrespective of the method (say GET) or status code (any 3XX).
    if (!self.followOriginalHttpMethod &&
      response.statusCode !== 401 && response.statusCode !== 307 && response.statusCode !== 308) {
        // force all redirects to use GET (legacy reasons)
        // but, HEAD is considered as a safe method so, the method is retained.
      if (request.method !== 'HEAD') {
        request.method = 'GET'
      }

      // Remove parameters from the previous response, unless this is the second request
      // for a server that requires digest authentication.
      delete request.body
      delete request._form
      delete request._multipart
      if (request.headers) {
        request.removeHeader('content-type')
        request.removeHeader('content-length')
      }
    }

    // Restore form-data stream if request body is retained
    if (request.formData &&
        // make sure _form is released and there's no pending _streams left
        // which will be the case for 401 redirects. so, reuse _form on redirect
        // @note: multiple form-param / file-streams may cause following issue:
        // https://github.com/request/request/issues/887
        // @todo: expose stream errors as events
        request._form && request._form._released &&
        request._form._streams && !request._form._streams.length) {
      // reinitialize FormData stream for 307 or 308 redirects
      delete request._form
      // remove content-type header for new boundary
      request.removeHeader('content-type')
      // remove content-length header since FormValue may be dropped if its not a file stream
      request.removeHeader('content-length')

      var formData = []
      var resetFormData = function (key, value, paramOptions) {
        // if `value` is of type stream
        if (typeof (value && value.pipe) === 'function') {
          // bail out if not a file stream
          if (!(value.hasOwnProperty('fd') && value.path)) return
          // create new file stream
          value = fs.createReadStream(value.path)
        }

        formData.push({key: key, value: value, options: paramOptions})
      }
      for (var i = 0, ii = request.formData.length; i < ii; i++) {
        var formParam = request.formData[i]
        if (!formParam) { continue }
        resetFormData(formParam.key, formParam.value, formParam.options)
      }

      // setting `options.formData` will reinitialize FormData in `request.init`
      options.formData = formData
    }

    if (!self.removeRefererHeader) {
      request.setHeader('Referer', uriPrev.href)
    }

    request.emit('redirect')
    request.init(options)
    callback(null, true)
  }

  // test allowRedirect arity; if has more than one argument,
  // assume it's asynchronous via a callback
  if (self.allowRedirect.length > 1) {
    return self.allowRedirect.call(request, response, function (err, result) {
      if (err) return callback(err)
      processRedirect(result)
    })
  }

  var allowsRedirect = self.allowRedirect.call(request, response)
  if (allowsRedirect && allowsRedirect.then) {
    return allowsRedirect.then(processRedirect, callback)
  }

  // treat as a regular boolean
  processRedirect(allowsRedirect)
}

exports.Redirect = Redirect
