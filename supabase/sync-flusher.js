/**
 * Sequential one-at-a-time delivery. The queue owns durable operations.
 * No silent conflict merge, no discarded operations on HTTP failure.
 * Caller must start flush only from an authenticated, opted-in sync session.
 */
export function makeSyncFlusher({queue,applyBatch,onEvent=()=>{}}={}) {
  if(!queue || typeof queue.peek!=='function'
      || typeof queue.acknowledge!=='function'
      || typeof queue.markConflict!=='function'
      || typeof applyBatch!=='function') throw new Error('同期キューと通信処理が必要です');
  let flushing=false;
  return {
    isFlushing:()=>flushing,
    async flush() {
      if(flushing) return {status:'already_running'};
      flushing=true;
      let applied=0;
      try {
        while(true) {
          const entry=queue.peek();
          if(!entry) return {status:'empty',applied};
          if(entry.status==='conflict') return {status:'conflict',applied,batchId:entry.batchId};
          let result;
          try {
            result=await applyBatch({batchId:entry.batchId,operations:entry.operations});
          } catch(error) {
            onEvent({type:'retry_later',batchId:entry.batchId});
            return {status:'retry_later',applied,batchId:entry.batchId,error};
          }
          if(result?.status==='conflict') {
            queue.markConflict(entry.batchId);
            onEvent({type:'conflict',batchId:entry.batchId,conflicts:result.conflicts||[]});
            return {status:'conflict',applied,batchId:entry.batchId,
              conflicts:result.conflicts||[]};
          }
          if(result?.status!=='applied') {
            return {status:'retry_later',applied,batchId:entry.batchId,
              error:new Error('サーバーの結果が不明です')};
          }
          // Ack only after server confirms applied/replayed idempotent request.
          queue.acknowledge(entry.batchId);
          applied++;
          onEvent({type:'applied',batchId:entry.batchId});
        }
      } finally {
        flushing=false;
      }
    }
  };
}
