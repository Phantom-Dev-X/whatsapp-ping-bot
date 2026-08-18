const { checkAndUpdate, startWatcher } = require('./auto-deploy');

(async () => {
  await checkAndUpdate({ restart: false });
  startWatcher();
  require('./index.js');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
