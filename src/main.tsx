import ReactDOM from "react-dom/client";
import App from "./App";

// No StrictMode: its double-run effects would start every terminal twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
