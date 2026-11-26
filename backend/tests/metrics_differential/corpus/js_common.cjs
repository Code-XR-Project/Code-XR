'use strict';

const handlers = {
  start(config) {
    return config && config.enabled ? 'on' : 'off';
  },
  stop: function (reason) {
    switch (reason) {
      case 'user':
        return 1;
      case 'error':
        return 2;
      default:
        return 0;
    }
  },
};

module.exports = function dispatch(name, arg) {
  const handler = handlers[name];
  if (!handler) {
    return null;
  }
  return handler(arg);
};
