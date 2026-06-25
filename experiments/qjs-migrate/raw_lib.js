addToLibrary({
  host_suspend: function (query) {
    var we = Module.wasmExports;
    if (we.asyncify_get_state() === 2) {        // REWINDING: resumed (maybe in another instance)
      we.asyncify_stop_rewind();
      return Module.__dbresult | 0;             // the DB/DOM result the destination host supplied
    }
    Module.__query = query;                      // record the request
    we.asyncify_start_unwind(Module.__dataPtr);
    return 0;                                     // dummy (unwinding)
  }
});
