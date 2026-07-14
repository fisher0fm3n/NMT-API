module.exports = {
  apps: [{
    name: "myapi",
    script: "server.js",
    env: {
      NODE_ENV: "production",
      PORT: 3000
    },

    /* ---- Auto-reload on file changes ---- */
    watch: ["."],                 // watch the whole app dir
    ignore_watch: ["node_modules","logs",".git",".cache"],
    watch_delay: 500,             // debounce restarts (ms)

    /* ---- Robustness ---- */
    instances: 1,                 // or "max" for clustering
    exec_mode: "fork",            // or "cluster" with instances>1
    max_memory_restart: "300M",

    /* ---- Logs (optional) ---- */
    out_file: "/var/log/myapi/out.log",
    error_file: "/var/log/myapi/error.log",
    combine_logs: true
  }]
}
