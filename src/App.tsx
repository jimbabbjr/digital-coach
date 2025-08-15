import Chat from "./components/Chat";

export default function App() {
  return (
    <div style={{ maxWidth: 768, margin: "2rem auto", padding: "1rem" }}>
      <h1 style={{ fontSize: 24, marginBottom: 12 }}>Digital Coach (MVP)</h1>
      <Chat />
    </div>
  );
}