import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Load environment variables from server/.env regardless of current working directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

export const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;

// Allow Vite dev server by default
export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

// Where jobs are stored temporarily
export const JOB_DIR = process.env.JOB_DIR || "./tmp/jobs";

// Vendor list file path
export const VENDOR_XLSX_PATH = process.env.VENDOR_XLSX_PATH || "./data/Vendor List.xlsx";

// If OCRmyPDF is installed, set this to "1" to force OCR even when some text exists
export const FORCE_OCR = process.env.FORCE_OCR === "1";
