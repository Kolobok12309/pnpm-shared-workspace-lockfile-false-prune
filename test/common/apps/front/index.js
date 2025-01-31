const shared = require('shared');
const injectedShared = require('injected-shared');

console.log('front');
shared();
injectedShared();
