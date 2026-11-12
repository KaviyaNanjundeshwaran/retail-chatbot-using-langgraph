import "./env";
import { createApp } from "./server";

const PORT = Number(process.env.PORT || 3001);

const app = createApp();

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
