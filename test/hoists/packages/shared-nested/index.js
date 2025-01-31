const shared = require('shared');

module.exports = () => {
  shared();
  console.log('shared-nested');
};
