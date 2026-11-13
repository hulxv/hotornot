import { mocks } from "../mocks/index.js";

export function GET() {
  return Response.json(mocks.metadata);
}
