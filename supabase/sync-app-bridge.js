/** Serialize every legacy save through one durable journal before syncing. */
export function createSyncAppBridge({engine, view, onStatus=()=>{}}) {
  let displayed = engine.snapshot().localDb;
  let tail = Promise.resolve();
  let queued = 0;
  let failed = false;
  let closed = false;
  let syncing = false;

  function busy(value) { view.setBusy(value); }
  function currentView() {
    displayed = engine.snapshot().localDb;
    view.replace(structuredClone(displayed));
  }
  async function synchronize() {
    const result = await engine.sync();
    onStatus(result);
    return result;
  }
  return {
    save(nextDb) {
      if (closed || failed || syncing) {
        onStatus({status:'blocked', reason:'保存を停止しています。保存済み状態を再表示してください'});
        currentView();
        return Promise.resolve({status:'blocked'});
      }
      const next = structuredClone(nextDb);
      queued++;
      // Do not make the ledger inert for routine field saves: doing so blurs
      // the active input on every keystroke (and can jump the page to top).
      // The serialized journal still guards durability and conflicts.
      tail = tail.then(async()=>{
        if (failed || closed) return {status:'blocked'};
        try {
          await engine.saveLocal(next, {expectedLocalDb:displayed});
          displayed = engine.snapshot().localDb;
          onStatus({status:'saved_locally'});
          return {status:'saved_locally'};
        } catch(error) {
          failed = true;
          onStatus({status:'save_failed', reason:error.message});
          return {status:'save_failed'};
        }
      }).finally(async()=>{
        queued--;
        if (queued !== 0) return;
        // Successful input saves retain DOM/focus. Only a failure rolls back
        // here. Explicit sync separately replaces the view after receiving.
        if (failed) currentView();
        busy(failed || closed || syncing || !!engine.snapshot().conflict);
      });
      return tail;
    },
    async sync() {
      if (syncing || closed || failed) return {status:'blocked'};
      syncing = true;
      busy(true);
      try { await tail; return await synchronize(); }
      finally { syncing=false; currentView(); busy(closed || failed || !!engine.snapshot().conflict); }
    },
    async recover() {
      await tail;
      if (closed) return;
      currentView();
      failed = false;
      busy(!!engine.snapshot().conflict);
    },
    settled:()=>tail,
    isBusy:()=>queued > 0,
    close(){ closed=true; busy(true); }
  };
}
