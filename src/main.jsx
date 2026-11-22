import React from "react";
import { createRoot } from "react-dom/client";
import "./pens.js"; // registers the pen renderer hook before Excalidraw renders
import App from "./App.jsx";
import "./styles.css";

window.EXCALIDRAW_ASSET_PATH = "/";
createRoot(document.getElementById("root")).render(<App />);
