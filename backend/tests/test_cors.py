"""Verify CORS still works after CORS_ORIGINS was moved from hardcoded '*' to env-driven config."""
import os
import requests

BASE_URL = os.environ.get(
    "EXPO_BACKEND_URL",
    "https://move-sense-1.preview.emergentagent.com",
).rstrip("/")


def test_cors_preflight_allows_cross_origin():
    """OPTIONS preflight from a foreign origin should return proper CORS headers."""
    r = requests.options(
        f"{BASE_URL}/api/status",
        headers={
            "Origin": "https://example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
        timeout=15,
    )
    assert r.status_code in (200, 204), r.text
    allow_origin = r.headers.get("access-control-allow-origin", "")
    # With CORS_ORIGINS="*" env, starlette echoes '*' (or the origin when credentials=true).
    assert allow_origin in ("*", "https://example.com"), r.headers
    allow_methods = r.headers.get("access-control-allow-methods", "")
    assert "POST" in allow_methods.upper() or allow_methods == "*", r.headers


def test_cors_actual_get_includes_allow_origin_header():
    """Real GET with Origin should carry Access-Control-Allow-Origin in the response."""
    r = requests.get(
        f"{BASE_URL}/api/",
        headers={"Origin": "https://example.com"},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    assert r.json().get("message") == "Hello World"
    allow_origin = r.headers.get("access-control-allow-origin", "")
    assert allow_origin in ("*", "https://example.com"), dict(r.headers)
