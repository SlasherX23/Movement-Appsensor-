"""Tests for POST /api/analyze-motion (Claude Sonnet 5 vision integration)."""
import base64
import io
import os
import pytest
import requests
from PIL import Image, ImageDraw

BASE_URL = os.environ.get(
    "EXPO_BACKEND_URL",
    "https://move-sense-1.preview.emergentagent.com",
).rstrip("/")

VALID_CLASSES = {"person", "pet", "vehicle", "other"}


def _make_jpeg_b64() -> str:
    """Generate a real 256x256 JPEG with clear visual features (colored shapes)."""
    img = Image.new("RGB", (256, 256), (30, 40, 60))
    d = ImageDraw.Draw(img)
    # A "vehicle" like colored rectangle body + two wheels
    d.rectangle([40, 130, 216, 200], fill=(200, 40, 40), outline=(255, 255, 255), width=3)
    d.rectangle([70, 100, 190, 140], fill=(220, 60, 60), outline=(255, 255, 255), width=2)
    d.ellipse([60, 190, 100, 230], fill=(20, 20, 20), outline=(240, 240, 240), width=2)
    d.ellipse([160, 190, 200, 230], fill=(20, 20, 20), outline=(240, 240, 240), width=2)
    d.line([0, 235, 256, 235], fill=(180, 180, 180), width=3)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def jpeg_b64():
    return _make_jpeg_b64()


# --- validation cases (fast) ---
def test_analyze_motion_empty_body_returns_422(api):
    r = api.post(f"{BASE_URL}/api/analyze-motion", json={}, timeout=15)
    assert r.status_code == 422, r.text


def test_analyze_motion_empty_image_string_returns_400(api):
    r = api.post(
        f"{BASE_URL}/api/analyze-motion",
        json={"image_base64": ""},
        timeout=15,
    )
    # Empty string passes pydantic but backend raises 400
    assert r.status_code in (400, 422), r.text
    if r.status_code == 400:
        assert "image_base64" in r.text.lower() or "required" in r.text.lower()


# --- happy path (slow: real LLM call) ---
def test_analyze_motion_valid_jpeg_returns_full_payload(api, jpeg_b64):
    r = api.post(
        f"{BASE_URL}/api/analyze-motion",
        json={"image_base64": jpeg_b64},
        timeout=90,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    # schema
    assert set(data.keys()) >= {"classification", "description", "spoken_alert"}
    # classification value
    assert data["classification"] in VALID_CLASSES, data
    # non-empty strings
    assert isinstance(data["description"], str) and data["description"].strip()
    assert isinstance(data["spoken_alert"], str) and data["spoken_alert"].strip()
    # spoken_alert should embed description-ish content and start with an alert prefix
    prefixes = ("Person detected.", "Pet detected.", "Vehicle detected.", "Motion detected.")
    assert data["spoken_alert"].startswith(prefixes), data["spoken_alert"]


def test_analyze_motion_data_uri_prefix_supported(api, jpeg_b64):
    """The endpoint should strip data URI prefix if present."""
    data_uri = f"data:image/jpeg;base64,{jpeg_b64}"
    r = api.post(
        f"{BASE_URL}/api/analyze-motion",
        json={"image_base64": data_uri},
        timeout=90,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["classification"] in VALID_CLASSES
    assert data["description"].strip()
    assert data["spoken_alert"].strip()
