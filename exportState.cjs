let sharedState;

async function getGlobalStateHandler() {
  if (!sharedState) {
    sharedState = await import('./src/sharedState.js');
  }
  return sharedState.getGlobalStateHandler();
}

module.exports = {
  getGlobalStateHandler
};
