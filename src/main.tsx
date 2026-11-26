import ReactDOM from "react-dom/client";
import App from "./App";
import { useStore } from "./store";

// Surface unexpected errors instead of failing silently.
const report = (msg: string) => {
  console.error(msg);
  useStore.getState().toast(`Internal error: ${msg}`, "error");
};
window.addEventListener("error", (e) => report(e.message));
window.addEventListener("unhandledrejection", (e) => report(String(e.reason?.stack ?? e.reason)));

// No StrictMode: its double-run effects would start every terminal twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
