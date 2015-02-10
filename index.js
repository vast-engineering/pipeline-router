/* global logger */
var util = require('util');
var events = require('events');
var _ = require('lodash');
var HttpContext = require('./lib/httpcontext.js');
var pipeline = require('node-pipeline');
var formidable = require('formidable');

var Router = function() {
  var that = this;
  this.plRouter = pipeline.create();
  this.reset();

  this.on('body', function() {
    that.parsed = true;
  });

  this.plRouter.on('error', function(err, results) {
    if (err) {
      that.emit('error', err, results);
    }
  });

};

util.inherits(Router, events.EventEmitter);

Router.prototype.reset = function() {
  this.plRouter.reset();
  this.params = [];
  this.query = null;
  this.parsed = false;
  this.httpContext = null;
  this.timeout = 120000; // same as node socket timeout
};

Router.prototype.dispatch = function(request, response) {
  this.reset(); // reset everything.
  var that = this;
  var httpContext = this.httpContext = new HttpContext(request, response);

  // parse body on post
  if (/(POST|PUT)/i.test(httpContext.request.method) && /(urlencoded|json)/i.test(httpContext.request.headers['content-type'])) {
    var form = new formidable.IncomingForm();

    form.on('field', function(field, value) {
      httpContext.body = httpContext.body || {};
      httpContext.body[field] = value;
    });

    form.on('error', function(err) {
      httpContext.body = err;
      that.emit('body', err);
    });

    form.on('end', function() {
      that.emit('body', httpContext.body);
    });

    form.parse(httpContext.request);
  }
  else {
    httpContext.body = [];

    httpContext.request.on('data', function(chunk) {
      httpContext.body.push(chunk);
    });

    httpContext.request.on('end', function() {
      httpContext.body = Buffer.concat(httpContext.body);
      that.emit('body', httpContext.body);
    });
  }


  this.plRouter.on('end', function(err, results) {
    var matched = results[0].matched,
      res = results[0].httpContext.response;

    that.emit('end', err, results);

    if ((!matched || err) && res) {
      res.statusCode = 404;
      res.write("No matching route or failed route");
      res.end(err ? err.stack : '');
    }
  });

  this.plRouter.execute({
    httpContext: httpContext
  });
};



Router.prototype.use = function(method, urlformat, options, handle) {
  options = options || {};
  var that = this;

  options.handle = _.last(arguments);
  options.method = method.toUpperCase();
  options.query = _.pick(this.query, options.query);

  if (options.timeout == null) {
    options.timeout = this.timeout; // default 30s timeout
  }

  // support plain old regex
  if (urlformat instanceof RegExp) {
    options.urlformat = urlformat;
  } else {
    _.extend(options, this.parseParams(urlformat, options.params));
  }

  var emitEvaluateEvent = function(httpContext, matched) {
    var data = {
      method: method,
      urlformat: urlformat,
      options: options,
      httpContext: httpContext,
      matched: matched
    };

    that.emit('evaluate', data);

    if (matched) {
      that.emit('match', data);
      that.plRouter.end();
    }
  };

  this.plRouter.use(function(data, next) {
    var matched = data[0].matched,
      httpContext = data[0].httpContext,
      fragment = null;

    // quick fail check
    if (matched || httpContext.request.method !== options.method) {
      next();
      return;
    }

    // evaluate hash for rest match
    if (httpContext.url.hash && options.urlformat.test(httpContext.url.hash.slice(1))) {
      // hash matched. lets set flag
      matched = true;
      fragment = httpContext.url.hash.slice(1);
    }

    // evaluate pathname for rest match
    else if (options.urlformat.test(httpContext.url.pathname)) {
      // pathname matched. lets set flag
      matched = true;
      fragment = httpContext.url.pathname;
    }


    if (matched) {
      // validate query against params.  if any of the regex fail, then matched will change to false.
      _.each(options.query, function(regex, key) {
        matched = matched && regex.test(httpContext.url.query[key]);
      });
    }

    // stop trying to match if query matched too
    if (matched) {
      httpContext.query = httpContext.url.query;
      data[0].matched = true;
      next(null, options);

      // send to handler
      httpContext.params = that.parseUrl(fragment, options.paramMap);
      emitEvaluateEvent(httpContext, true);

      if (options.timeout) {
        var res = httpContext.response;

        if (res) {
          var resTimeout = setTimeout(function() {

            if (!res.headersSent) {
              res.writeHead(500, {
                'Content-Type': 'text/html'
              });
            }
            res.end('Request timed out');

          }, options.timeout);

          res.on('finish', clearTimeout.bind(null, resTimeout));
        }
      }

      if (/(POST|PUT)/i.test(httpContext.request.method) && !that.parsed) {
        that.on('body', function() {
          options.handle(httpContext);
        });
      } else {
        options.handle(httpContext);
      }
    } else {
      emitEvaluateEvent(httpContext, false);
      next();
    }
  });
};
Router.prototype.get = function(urlformat, options, callback) {
  Array.prototype.splice.call(arguments, 0, 0, 'get');
  return this.use.apply(this, arguments);
};
Router.prototype.post = function(urlformat, options, callback) {
  Array.prototype.splice.call(arguments, 0, 0, 'post');
  return this.use.apply(this, arguments);
};
Router.prototype.param = function(arg0, arg1) {
  var params = [];

  if (_.isArray(arg0)) {
    params = arg0;
  } else {
    // insert the single param to the array for concat below.
    params.push({
      name: arg0,
      regex: arg1
    });
  }

  // convert nulls and strings to regex
  _.each(params, function(p) {
    // default null vals to catch all regex.
    if (p.regex == null) {
      p.regex = /(.*)/;
    }
    // convert string vals to regex.
    else if (_.isString(p.regex)) {
      p.regex = new RegExp(p.regex);
    }
  });

  // add to the array of params for this instance
  this.params = this.params.concat(params);
};



Router.prototype.parseUrl = function(url, paramMap) {
  var restParams = url.split('/'),
    ret = {},
    that = this;

  if (restParams[0] === "") {
    restParams.splice(0, 1);
  }

  _.each(paramMap, function(pmap, i) {
    var param = restParams[i];
    if (param && pmap) {
      var m = pmap.regex.exec(param);
      if (m) {
        ret[pmap.name] = decodeURIComponent(_.last(m));
      }
    }
  });

  return ret;

};
/** ------- **/

var regexSplit = /(\?|\/)([^\?^\/]+)/g;
Router.prototype.parseParams = function(path, params) {
  path = path || '';

  var restParams = path.match(regexSplit);
  var that = this;
  var paramMap = [];
  var urlformat = [];

  if (!restParams || restParams.length === 0) {
    restParams = [path];
  }

  // replace named params with corresponding regexs and build paramMap.
  var /*RegExp*/ isRestParam = new RegExp('^\/:');
  _.each(restParams, function(/*string*/urlPart) {
    if (isRestParam.test(urlPart)) {
      var paramName = urlPart.substring(2);
      var param = _.find(that.params, function(p) {
        var paramConfig = params[paramName];
        return (p.name === paramName && p.regex.source === paramConfig.regex);
      });

      if (!param) {
        logger.error('Route ' + path + ' does not have a matching REST parameter ' + paramName);
        return;
      }
      paramMap.push(param);
      var regexStr = param.regex.toString();
      urlformat.push('\\/' + (urlPart[0] === '?' ? '?' : '')); // push separator (double backslash escapes the ? or /)
      urlformat.push(regexStr.substring(1, regexStr.length - 1)); // push regex
    } else {
      paramMap.push(null);
      urlformat.push(urlPart);
    }
  });

  return {
    urlformat: new RegExp('^' + urlformat.join('') + '$'),
    paramMap: paramMap
  };
};

Router.prototype.qparam = function(name, regex) {
  this.query = this.query || {};
  this.query[name] = regex;
};

module.exports = Router;
