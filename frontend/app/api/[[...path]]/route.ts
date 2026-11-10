import { NextRequest } from "next/server";
import { GET as handleGet, POST as handlePost, PUT as handlePut } from "@/backend/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const GET = (req: NextRequest) => handleGet(req);
export const POST = (req: NextRequest) => handlePost(req);
export const PUT = (req: NextRequest) => handlePut(req);

