// The one constant both tiers must agree on: where the session endpoint lives. In its own
// module so the browser host never imports the Node server (and vice versa).
export const WS_PATH = "/__stackmix";
