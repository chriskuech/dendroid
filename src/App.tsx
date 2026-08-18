import { AppStateProvider } from "./lib/AppState";
import { Shell } from "./ux/Shell";
import "./App.css";

function App() {
  return (
    <AppStateProvider>
      <Shell />
    </AppStateProvider>
  );
}

export default App;
