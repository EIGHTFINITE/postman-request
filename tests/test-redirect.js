'use strict'

var server = require('./server')
var assert = require('assert')
var request = require('../index')
var tape = require('tape')
var http = require('http')
var destroyable = require('server-destroy')
var Promise = require('bluebird')

var s = server.createServer()
var ss = server.createSSLServer()
var hits = {}
var jar = request.jar()

destroyable(s)
destroyable(ss)

s.on('/ssl', function (req, res) {
  res.writeHead(302, {
    location: ss.url + '/'
  })
  res.end()
})

ss.on('/', function (req, res) {
  res.writeHead(200)
  res.end('SSL')
})

function createRedirectEndpoint (code, label, landing) {
  s.on('/' + label, function (req, res) {
    hits[label] = true
    res.writeHead(code, {
      'location': s.url + '/' + landing,
      'set-cookie': 'ham=eggs'
    })
    res.end()
  })
}

function createLandingEndpoint (landing) {
  s.on('/' + landing, function (req, res) {
    // Make sure the cookie doesn't get included twice, see #139:
    // Make sure cookies are set properly after redirect
    assert.equal(req.headers.cookie, 'foo=bar; quux=baz; ham=eggs')
    hits[landing] = true
    res.writeHead(200, {
      'x-response': req.method.toUpperCase() + ' ' + landing,
      'x-content-length': String(req.headers['content-length'] || 0)
    })
    res.end(req.method.toUpperCase() + ' ' + landing)
  })
}

function bouncer (code, label, hops) {
  var hop
  var landing = label + '_landing'
  var currentLabel
  var currentLanding

  hops = hops || 1

  if (hops === 1) {
    createRedirectEndpoint(code, label, landing)
  } else {
    for (hop = 0; hop < hops; hop++) {
      currentLabel = (hop === 0) ? label : label + '_' + (hop + 1)
      currentLanding = (hop === hops - 1) ? landing : label + '_' + (hop + 2)

      createRedirectEndpoint(code, currentLabel, currentLanding)
    }
  }

  createLandingEndpoint(landing)
}

tape('setup', function (t) {
  s.listen(0, function () {
    ss.listen(0, function () {
      bouncer(301, 'temp')
      bouncer(301, 'double', 2)
      bouncer(301, 'treble', 3)
      bouncer(302, 'perm')
      bouncer(302, 'nope')
      bouncer(307, 'fwd')
      t.end()
    })
  })
})

tape('permanent bounce', function (t) {
  jar.setCookieSync('quux=baz', s.url)
  hits = {}
  request({
    uri: s.url + '/perm',
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.perm, 'Original request is to /perm')
    t.ok(hits.perm_landing, 'Forward to permanent landing URL')
    t.equal(body, 'GET perm_landing', 'Got permanent landing content')
    t.end()
  })
})

tape('preserve HEAD method when using followAllRedirects', function (t) {
  jar.setCookieSync('quux=baz', s.url)
  hits = {}
  request({
    method: 'HEAD',
    uri: s.url + '/perm',
    followAllRedirects: true,
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.perm, 'Original request is to /perm')
    t.ok(hits.perm_landing, 'Forward to permanent landing URL')
    t.equal(res.headers['x-response'], 'HEAD perm_landing', 'Got permanent landing content')
    t.end()
  })
})

tape('temporary bounce', function (t) {
  hits = {}
  request({
    uri: s.url + '/temp',
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(hits.temp_landing, 'Forward to temporary landing URL')
    t.equal(body, 'GET temp_landing', 'Got temporary landing content')
    t.end()
  })
})

tape('prevent bouncing', function (t) {
  hits = {}
  request({
    uri: s.url + '/nope',
    jar: jar,
    headers: { cookie: 'foo=bar' },
    followRedirect: false
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 302)
    t.ok(hits.nope, 'Original request to /nope')
    t.ok(!hits.nope_landing, 'No chasing the redirect')
    t.equal(res.statusCode, 302, 'Response is the bounce itself')
    t.end()
  })
})

tape('should not follow post redirects by default', function (t) {
  hits = {}
  request.post(s.url + '/temp', {
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 301)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(!hits.temp_landing, 'No chasing the redirect when post')
    t.equal(res.statusCode, 301, 'Response is the bounce itself')
    t.end()
  })
})

tape('should follow post redirects when followallredirects true', function (t) {
  hits = {}
  request.post({
    uri: s.url + '/temp',
    followAllRedirects: true,
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(hits.temp_landing, 'Forward to temporary landing URL')
    t.equal(body, 'GET temp_landing', 'Got temporary landing content')
    t.end()
  })
})

tape('should follow post redirects when followallredirects true and followOriginalHttpMethod is enabled', function (t) {
  hits = {}
  request.post({
    uri: s.url + '/temp',
    followAllRedirects: true,
    followOriginalHttpMethod: true,
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(hits.temp_landing, 'Forward to temporary landing URL')
    t.equal(body, 'POST temp_landing', 'Got temporary landing content')
    t.end()
  })
})

// @todo: probably introduce a new configuration to retain request body on
// redirects instead of mixing this with followOriginalHttpMethod
tape('should follow post redirects along with request body when followOriginalHttpMethod is enabled', function (t) {
  hits = {}
  request.post({
    uri: s.url + '/temp',
    followAllRedirects: true,
    followOriginalHttpMethod: true,
    jar: jar,
    headers: { cookie: 'foo=bar' },
    body: 'fooBar'
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(hits.temp_landing, 'Forward to temporary landing URL')
    t.equal(res.headers['x-content-length'], '6')
    t.equal(body, 'POST temp_landing', 'Got temporary landing content')
    t.end()
  })
})

tape('should not follow post redirects when followallredirects false', function (t) {
  hits = {}
  request.post({
    uri: s.url + '/temp',
    followAllRedirects: false,
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 301)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(!hits.temp_landing, 'No chasing the redirect')
    t.equal(res.statusCode, 301, 'Response is the bounce itself')
    t.end()
  })
})

tape('should not follow delete redirects by default', function (t) {
  hits = {}
  request.del(s.url + '/temp', {
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.ok(res.statusCode >= 301 && res.statusCode < 400, 'Status is a redirect')
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(!hits.temp_landing, 'No chasing the redirect when delete')
    t.equal(res.statusCode, 301, 'Response is the bounce itself')
    t.end()
  })
})

tape('should not follow delete redirects even if followredirect is set to true', function (t) {
  hits = {}
  request.del(s.url + '/temp', {
    followRedirect: true,
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 301)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(!hits.temp_landing, 'No chasing the redirect when delete')
    t.equal(res.statusCode, 301, 'Response is the bounce itself')
    t.end()
  })
})

tape('should follow delete redirects when followallredirects true', function (t) {
  hits = {}
  request.del(s.url + '/temp', {
    followAllRedirects: true,
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(hits.temp_landing, 'Forward to temporary landing URL')
    t.equal(body, 'GET temp_landing', 'Got temporary landing content')
    t.end()
  })
})

// @note Previously all the methods get redirected with their request method
// preserved(not changed to GET) other than the following 4:
// PATCH, PUT, POST, DELETE (Probably accounted for only GET & HEAD).
// BUT, with followAllRedirects set, the request method is changed to GET for
// non GET & HEAD methods.
//
// Since: https://github.com/postmanlabs/postman-request/pull/31
// non GET & HEAD methods get redirects with their method changed to GET unless
// followOriginalHttpMethod is set.
tape('should follow options redirects by default', function (t) {
  hits = {}
  request({
    method: 'OPTIONS', // options because custom method is not supported by Node's HTTP server
    uri: s.url + '/temp',
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(hits.temp_landing, 'Forward to temporary landing URL')
    t.equal(body, 'GET temp_landing', 'Got temporary landing content') // Previously redirected with OPTIONS
    t.end()
  })
})

tape('should follow options redirects when followallredirects true', function (t) {
  hits = {}
  request({
    method: 'OPTIONS',
    uri: s.url + '/temp',
    followAllRedirects: true,
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(hits.temp_landing, 'Forward to temporary landing URL')
    t.equal(body, 'GET temp_landing', 'Got temporary landing content')
    t.end()
  })
})

tape('should follow options redirects when followallredirects true and followOriginalHttpMethod is enabled', function (t) {
  hits = {}
  request({
    method: 'OPTIONS',
    uri: s.url + '/temp',
    followAllRedirects: true,
    followOriginalHttpMethod: true,
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(hits.temp_landing, 'Forward to temporary landing URL')
    t.equal(body, 'OPTIONS temp_landing', 'Got temporary landing content')
    t.end()
  })
})

tape('should follow 307 delete redirects when followallredirects true', function (t) {
  hits = {}
  request.del(s.url + '/fwd', {
    followAllRedirects: true,
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.fwd, 'Original request is to /fwd')
    t.ok(hits.fwd_landing, 'Forward to temporary landing URL')
    t.equal(body, 'DELETE fwd_landing', 'Got temporary landing content')
    t.end()
  })
})

tape('double bounce', function (t) {
  hits = {}
  request({
    uri: s.url + '/double',
    jar: jar,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.double, 'Original request is to /double')
    t.ok(hits.double_2, 'Forward to temporary landing URL')
    t.ok(hits.double_landing, 'Forward to landing URL')
    t.equal(body, 'GET double_landing', 'Got temporary landing content')
    t.end()
  })
})

tape('double bounce terminated after first redirect', function (t) {
  function filterDouble (response) {
    return (response.headers.location || '').indexOf('double_2') === -1
  }

  hits = {}
  request({
    uri: s.url + '/double',
    jar: jar,
    headers: { cookie: 'foo=bar' },
    followRedirect: filterDouble
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 301)
    t.ok(hits.double, 'Original request is to /double')
    t.equal(res.headers.location, s.url + '/double_2', 'Current location should be ' + s.url + '/double_2')
    t.end()
  })
})

tape('triple bounce terminated after second redirect', function (t) {
  function filterTreble (response) {
    return (response.headers.location || '').indexOf('treble_3') === -1
  }

  hits = {}
  request({
    uri: s.url + '/treble',
    jar: jar,
    headers: { cookie: 'foo=bar' },
    followRedirect: filterTreble
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 301)
    t.ok(hits.treble, 'Original request is to /treble')
    t.equal(res.headers.location, s.url + '/treble_3', 'Current location should be ' + s.url + '/treble_3')
    t.end()
  })
})

tape('asynchronous followRedirect filter via callback', function (t) {
  function filterAsync (response, callback) {
    setImmediate(function () { callback(null, true) })
    return false // it should ignore this due to the function arity
  }

  hits = {}
  request({
    uri: s.url + '/temp',
    jar: jar,
    headers: { cookie: 'foo=bar' },
    followRedirect: filterAsync
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(hits.temp_landing, 'Forward to temporary landing URL')
    t.equal(body, 'GET temp_landing', 'Got temporary landing content')
    t.end()
  })
})

tape('asynchronous followRedirect filter via callback with error', function (t) {
  var sampleError = new Error('Error during followRedirect callback')
  function filterAsync (response, callback) {
    setImmediate(function () { callback(sampleError) })
  }

  hits = {}
  request({
    uri: s.url + '/temp',
    jar: jar,
    headers: { cookie: 'foo=bar' },
    followRedirect: filterAsync
  }, function (err, res, body) {
    t.equal(err, sampleError)
    t.end()
  })
})

tape('asynchronous followRedirect filter via promise', function (t) {
  function filterPromise (response) {
    return Promise.resolve(false)
  }

  hits = {}
  request({
    uri: s.url + '/temp',
    jar: jar,
    headers: { cookie: 'foo=bar' },
    followRedirect: filterPromise
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 301)
    t.ok(hits.temp, 'Original request is to /temp')
    t.ok(!hits.temp_landing, 'No chasing the redirect promise returns false')
    t.equal(res.statusCode, 301, 'Response is the bounce itself')
    t.end()
  })
})

tape('asynchronous followRedirect filter via promise (rejected)', function (t) {
  var sampleError = new Error('Rejected followRedirect promise')
  function filterPromise (response) {
    return Promise.reject(sampleError)
  }

  hits = {}
  request({
    uri: s.url + '/temp',
    jar: jar,
    headers: { cookie: 'foo=bar' },
    followRedirect: filterPromise
  }, function (err, res, body) {
    t.equal(err, sampleError)
    t.end()
  })
})

tape('overridden redirect url', function (t) {
  hits = {}
  request({
    uri: s.url + '/temp',
    jar: jar,
    headers: { cookie: 'foo=bar' },
    followRedirect: function (response) {
      if (/temp_landing/.test(response.headers.location)) return s.url + '/perm'
      return true
    }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.ok(hits.perm, 'Original request to /perm')
    t.ok(hits.perm_landing, 'Forward to permanent landing URL')
    t.equal(body, 'GET perm_landing', 'Got permanent landing content')
    t.end()
  })
})

tape('http to https redirect', function (t) {
  hits = {}
  request.get({
    uri: require('url').parse(s.url + '/ssl'),
    allowInsecureRedirect: true,
    rejectUnauthorized: false
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.equal(body, 'SSL', 'Got SSL redirect')
    t.end()
  })
})

tape('http to https redirect should fail without the explicit "allowInsecureRedirect" option', function (t) {
  hits = {}
  request.get({
    uri: require('url').parse(s.url + '/ssl'),
    rejectUnauthorized: false
  }, function (err, res, body) {
    t.notEqual(err, null)
    t.equal(err.message, 'Protocol "https:" not supported. Expected "http:"', 'Failed to cross-protocol redirect')
    t.end()
  })
})

tape('should have referer header by default when following redirect', function (t) {
  request.post({
    uri: s.url + '/temp',
    jar: jar,
    followAllRedirects: true,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.end()
  })
  .on('redirect', function () {
    t.equal(this.headers.Referer, s.url + '/temp')
  })
})

tape('should not have referer header when removeRefererHeader is true', function (t) {
  request.post({
    uri: s.url + '/temp',
    jar: jar,
    followAllRedirects: true,
    removeRefererHeader: true,
    headers: { cookie: 'foo=bar' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.end()
  })
  .on('redirect', function () {
    t.equal(this.headers.Referer, undefined)
  })
})

tape('should preserve referer header set in the initial request when removeRefererHeader is true', function (t) {
  request.post({
    uri: s.url + '/temp',
    jar: jar,
    followAllRedirects: true,
    removeRefererHeader: true,
    headers: { cookie: 'foo=bar', referer: 'http://awesome.com' }
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.end()
  })
  .on('redirect', function () {
    t.equal(this.headers.referer, 'http://awesome.com')
  })
})

tape('should use same agent class on redirect', function (t) {
  var agent
  var calls = 0
  var agentOptions = {}

  function FakeAgent (agentOptions) {
    var createConnection

    agent = new http.Agent(agentOptions)
    createConnection = agent.createConnection
    agent.createConnection = function () {
      calls++
      return createConnection.apply(agent, arguments)
    }

    return agent
  }

  hits = {}
  request.get({
    uri: s.url + '/temp',
    jar: jar,
    headers: { cookie: 'foo=bar' },
    agentOptions: agentOptions,
    agentClass: FakeAgent
  }, function (err, res, body) {
    t.equal(err, null)
    t.equal(res.statusCode, 200)
    t.equal(body, 'GET temp_landing', 'Got temporary landing content')
    t.equal(calls, 2)
    t.ok(this.agent === agent, 'Reinstantiated the user-specified agent')
    t.ok(this.agentOptions === agentOptions, 'Reused agent options')
    t.end()
  })
})

tape('cleanup', function (t) {
  s.destroy(function () {
    ss.destroy(function () {
      t.end()
    })
  })
})
