import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Widget } from "./Widget.js";
import "./styles.css";

// /widget (or ?view=widget) renders the compact menu-bar popover view.
const isWidget = location.pathname.replace(/\/$/, "") === "/widget" || new URLSearchParams(location.search).get("view") === "widget";
if (isWidget) {
  document.documentElement.dataset.view = "widget";
  // The Tauri popover passes ?host=tauri so the page goes transparent and lets the OS material through.
  const host = new URLSearchParams(location.search).get("host");
  if (host) document.documentElement.dataset.host = host;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isWidget ? <Widget /> : <App />}
  </React.StrictMode>,
);
