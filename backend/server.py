from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import json
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Literal, Optional
import uuid
from datetime import datetime

from emergentintegrations.llm.chat import (
    LlmChat,
    UserMessage,
    ImageContent,
    TextDelta,
    StreamDone,
)

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# MongoDB connection
mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# Define Models
class StatusCheck(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)


class StatusCheckCreate(BaseModel):
    client_name: str


class MotionAnalysisRequest(BaseModel):
    image_base64: str


class MotionAnalysisResponse(BaseModel):
    classification: Literal["person", "pet", "vehicle", "other"]
    description: str
    spoken_alert: str


# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Hello World"}


@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.dict()
    status_obj = StatusCheck(**status_dict)
    _ = await db.status_checks.insert_one(status_obj.dict())
    return status_obj


@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    status_checks = await db.status_checks.find().to_list(1000)
    return [StatusCheck(**status_check) for status_check in status_checks]


ANALYZE_SYSTEM_PROMPT = (
    "You are a security camera vision assistant. A motion trigger has fired. "
    "Look at the frame from the camera and respond with EXACTLY one compact JSON "
    "object (no markdown, no code fences, no prose before or after) with two keys:\n"
    '  "classification": one of "person", "pet", "vehicle", "other"\n'
    '  "description": a single short sentence (max 14 words) describing what '
    "is happening or what the primary subject is doing. Keep it neutral and factual.\n"
    'Example: {"classification":"person","description":"A person is walking past '
    'the doorway holding a bag."}'
)

VALID_CLASSES = {"person", "pet", "vehicle", "other"}


def _spoken_for(classification: str, description: str) -> str:
    prefix = {
        "person": "Person detected.",
        "pet": "Pet detected.",
        "vehicle": "Vehicle detected.",
        "other": "Motion detected.",
    }.get(classification, "Motion detected.")
    # Keep it short so TTS finishes before next cooldown window
    return f"{prefix} {description}".strip()


def _extract_json(text: str) -> Optional[dict]:
    if not text:
        return None
    t = text.strip()
    # Strip code fences if present
    if t.startswith("```"):
        t = t.strip("`")
        # remove possible leading "json\n"
        nl = t.find("\n")
        if nl != -1 and t[:nl].strip().lower() in {"json", ""}:
            t = t[nl + 1 :]
    # Slice to outer braces
    start = t.find("{")
    end = t.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    candidate = t[start : end + 1]
    try:
        return json.loads(candidate)
    except Exception:
        return None


@api_router.post("/analyze-motion", response_model=MotionAnalysisResponse)
async def analyze_motion(payload: MotionAnalysisRequest):
    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="EMERGENT_LLM_KEY not configured")

    image_b64 = payload.image_base64.strip()
    if not image_b64:
        raise HTTPException(status_code=400, detail="image_base64 is required")
    # Strip data URI prefix if present
    if image_b64.startswith("data:"):
        comma = image_b64.find(",")
        if comma != -1:
            image_b64 = image_b64[comma + 1 :]

    session_id = f"motion-{uuid.uuid4()}"
    chat = LlmChat(
        api_key=api_key,
        session_id=session_id,
        system_message=ANALYZE_SYSTEM_PROMPT,
    ).with_model("anthropic", "claude-sonnet-5")

    image = ImageContent(image_base64=image_b64)
    user_msg = UserMessage(
        text="Analyze this camera frame and respond with the JSON only.",
        file_contents=[image],
    )

    full_text = ""
    try:
        async for ev in chat.stream_message(user_msg):
            if isinstance(ev, TextDelta):
                full_text += ev.content
            elif isinstance(ev, StreamDone):
                break
    except Exception as e:
        logger.exception("Claude analyze-motion failed")
        raise HTTPException(status_code=502, detail=f"LLM call failed: {e}")

    data = _extract_json(full_text) or {}
    classification = str(data.get("classification", "other")).lower().strip()
    if classification not in VALID_CLASSES:
        classification = "other"
    description = str(data.get("description", "")).strip()
    if not description:
        description = full_text.strip()[:80] or "Movement observed in the scene."

    spoken = _spoken_for(classification, description)

    return MotionAnalysisResponse(
        classification=classification,  # type: ignore[arg-type]
        description=description,
        spoken_alert=spoken,
    )


# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=[o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
