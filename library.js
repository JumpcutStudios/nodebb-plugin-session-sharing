"use strict";

var meta = module.parent.require('./meta'),
	user = module.parent.require('./user');

var _ = module.parent.require('underscore'),
	winston = module.parent.require('winston'),
	async = module.parent.require('async'),
	db = module.parent.require('./database'),
	nconf = module.parent.require('nconf'),
	superagent = require('superagent');

var jwt = require('jsonwebtoken');

var controllers = require('./lib/controllers'),

	plugin = {
		ready: false,
		settings: {
			name: 'appId',
			cookieName: 'token',
			cookieDomain: undefined,
			secret: '',
			behaviour: 'trust',
			'payload:id': 'id',
			'payload:email': 'email',
			'payload:username': undefined,
			'payload:firstName': undefined,
			'payload:lastName': undefined,
			'payload:picture': 'picture',
			'payload:parent': undefined,
			exchangeTokenEndpoint: '',
			logoutEndpoint: ''
		}
	};

plugin.init = function(params, callback) {
	var router = params.router,
		hostMiddleware = params.middleware,
		hostControllers = params.controllers;

	router.get('/admin/plugins/session-sharing', hostMiddleware.admin.buildHeader, controllers.renderAdminPage);
	router.get('/api/admin/plugins/session-sharing', controllers.renderAdminPage);

	if (process.env.NODE_ENV === 'development') {
		router.get('/debug/session', plugin.generate);
	}

	plugin.reloadSettings(callback);
};

plugin.process = function(token, callback) {
	async.waterfall([
		async.apply(plugin.getToken, token),
		async.apply(plugin.verify),
		async.apply(plugin.findUser)
	], callback);
};

plugin.getToken = function (payload, callback) {
	superagent
		.post(plugin.settings.exchangeTokenEndpoint)
		.set('Accept', 'application/json')
		.send({
			refreshToken: payload
		})
		.end(function(err, res) {
			if(err) {
				callback(err);
				return;
			}

			jwt.verify(res.body.token, plugin.settings.secret, function (err, res) {
				if(err) {
					return callback(err);
				}
				callback(null, res);
			})
		});
}

plugin.verify = function(payload, callback) {
	var parent = plugin.settings['payload:parent'],
		email = parent ? payload[parent][plugin.settings['payload:email']] : payload[plugin.settings['payload:email']];
	if (!email ) {
		return callback(new Error('payload-invalid'));
	}

	callback(null, payload);
}

plugin.findUser = function(payload, callback) {
	// If payload id resolves to a user, return the uid, otherwise register a new user
	winston.verbose('[session-sharing] Payload verified');

	var parent = plugin.settings['payload:parent'],
		id = parent ? payload[parent][plugin.settings['payload:id']] : payload[plugin.settings['payload:id']],
		email = parent ? payload[parent][plugin.settings['payload:email']] : payload[plugin.settings['payload:email']],
		username = parent ? payload[parent][plugin.settings['payload:username']] : payload[plugin.settings['payload:username']],
		firstName = parent ? payload[parent][plugin.settings['payload:firstName']] : payload[plugin.settings['payload:firstName']],
		lastName = parent ? payload[parent][plugin.settings['payload:lastName']] : payload[plugin.settings['payload:lastName']],
		picture = parent ? payload[parent][plugin.settings['payload:picture']] : payload[plugin.settings['payload:picture']];

	if (!username && firstName && lastName) {
		username = [firstName, lastName].join(' ').trim();
	} else if (!username && firstName && !lastName) {
		username = firstName;
	} else if (!username && !firstName && lastName) {
		username = lastName;
	}

	async.parallel({
		uid: async.apply(db.getObjectField, plugin.settings.name + ':uid', id),
		mergeUid: async.apply(db.sortedSetScore, 'email:uid', email)
	}, function(err, checks) {
		var setUserName = function (uid, cb) {
			user.getUserData(uid, function (err, data) {
				if(err) {
					return cb(err);
				}
				if(data.username !== username) {
					user.updateProfile(uid, {'username': username}, function (err, res) {
						if(err) {
							return cb(err);
						}
						cb(null, res);
					});
				}
			});
		}

		if (err) { return callback(err); }
		if (checks.uid && !isNaN(parseInt(checks.uid, 10))) {
			setUserName(checks.mergeUid, function () {
				callback(null, {uid: checks.uid, user: {id: id}});
			})
			return;
		}
		else if (email && email.length && checks.mergeUid && !isNaN(parseInt(checks.mergeUid, 10))) {
			winston.info('[session-sharing] Found user via their email, associating this id (' + id + ') with their NodeBB account');
			db.setObjectField(plugin.settings.name + ':uid', id, checks.mergeUid);
			setUserName(checks.mergeUid, function () {
				callback(null, {uid: checks.mergeUid, user: {id: id}});
			})
			return;
		}

		// If no match, create a new user
		winston.info('[session-sharing] No user found, creating a new user for this login');
		username = username.trim();

		user.create({
			username: username,
			email: email,
			picture: picture,
			fullname: [firstName, lastName].join(' ').trim()
		}, function(err, uid) {
			if (err) { return callback(err); }

			db.setObjectField(plugin.settings.name + ':uid', id, uid);
			callback(null, {uid: uid, user: {id: id}});
		});
	});
};

plugin.addMiddleware = function(data, callback) {
	function handleGuest (req, res, next) {
		if (plugin.settings.guestRedirect) {
			// If a guest redirect is specified, follow it
			res.redirect(plugin.settings.guestRedirect.replace('%1', encodeURIComponent(nconf.get('url') + req.path)));
		} else {
			return next();
		}
	};

	data.app.use(function(req, res, next) {
		// Only respond to page loads by guests, not api or asset calls
		var blacklistedRoute = new RegExp('^' + nconf.get('relative_path') + '/(api|vendor|uploads|language|templates|debug)'),
			blacklistedExt = /\.(css|js|tpl|json)$/,
			hasSession = req.hasOwnProperty('user') && req.user.hasOwnProperty('uid') && parseInt(req.user.uid, 10) > 0;

		if (
			!plugin.ready 	// plugin not ready
			|| (plugin.settings.behaviour === 'trust' && hasSession)	// user logged in
			|| (req.path.match(blacklistedRoute) || req.path.match(blacklistedExt))	// path matches a blacklist
		) {
			return next();
		} else {
			if(req.path === '/logout') {
				req.session.logout = true;
				return next();
			}
			if(req.session.logout) {
				req.session.logout = false;
				if(plugin.settings.logoutEndpoint) {
					return res.redirect(plugin.settings.logoutEndpoint);
				}
				return next();
			}
			if (Object.keys(req.cookies).length && req.cookies.hasOwnProperty(plugin.settings.cookieName) && req.cookies[plugin.settings.cookieName].length) {
				return plugin.process(req.cookies[plugin.settings.cookieName], function(err, payload) {
					if (err) {
						switch(err.message) {
							case 'payload-invalid':
								winston.warn('[session-sharing] The passed-in payload was invalid and could not be processed');
								break;
							default:
								winston.warn('[session-sharing] Error encountered while parsing token: ' + err.message);
								break;
						}

						return handleGuest(req, res, next);
					}

					winston.info('[session-sharing] Processing login for uid ' + payload.uid);

					req.login({
						uid: payload.uid
					}, function() {

						req.uid = payload.uid;
						next();
					});
				});
			} else if (hasSession) {
				// Has login session but no cookie, logout
				req.logout();
				handleGuest.apply(null, arguments);
			} else {
				handleGuest.apply(null, arguments);
			}
		}
	});

	callback();
};

plugin.cleanup = function(req, res) {
	if (plugin.settings.cookieDomain) {
		winston.verbose('[session-sharing] Clearing cookie');
		res.cookie(plugin.settings.cookieName, {
			domain: plugin.settings.cookieDomain,
			expires: new Date(),
			path: '/'
		});
	}
};

plugin.generate = function(req, res) {
	var payload = {};
	payload[plugin.settings['payload:id']] = 1;
	payload[plugin.settings['payload:username']] = 'testUser';
	payload[plugin.settings['payload:email']] = 'testUser@example.org';
	var token = jwt.sign(payload, plugin.settings.secret)
	res.cookie('token', token, {
		maxAge: 1000*60*60*24*21,
		httpOnly: true,
		domain: plugin.settings.cookieDomain
	});

	res.sendStatus(200);
};

plugin.addAdminNavigation = function(header, callback) {
	header.plugins.push({
		route: '/plugins/session-sharing',
		icon: 'fa-user-secret',
		name: 'Session Sharing'
	});

	callback(null, header);
};

plugin.reloadSettings = function(callback) {
	meta.settings.get('session-sharing', function(err, settings) {
		if (err) {
			return callback(err);
		}

		if (!settings.hasOwnProperty('secret') || !settings.secret.length) {
			winston.error('[session-sharing] JWT Secret not found, session sharing disabled.');
			return callback();
		}

		winston.info('[session-sharing] Settings OK');
		plugin.settings = _.defaults(_.pick(settings, Boolean), plugin.settings);
		plugin.ready = true;

		callback();
	});
};

module.exports = plugin;