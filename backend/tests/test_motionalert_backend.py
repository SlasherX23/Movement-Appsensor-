import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "https://move-sense-1.preview.emergentagent.com").rstrip("/")


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# Health / root
def test_root_hello_world(api):
    r = api.get(f"{BASE_URL}/api/", timeout=15)
    assert r.status_code == 200
    assert r.json().get("message") == "Hello World"


# Mongo-backed status endpoints
def test_status_get_list(api):
    r = api.get(f"{BASE_URL}/api/status", timeout=15)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_status_create_and_persist(api):
    name = f"TEST_{uuid.uuid4().hex[:8]}"
    r = api.post(f"{BASE_URL}/api/status", json={"client_name": name}, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["client_name"] == name
    assert "id" in body and "timestamp" in body

    # Verify persistence via GET
    r2 = api.get(f"{BASE_URL}/api/status", timeout=15)
    assert r2.status_code == 200
    assert any(item.get("client_name") == name for item in r2.json())


def test_status_create_validation_error(api):
    r = api.post(f"{BASE_URL}/api/status", json={}, timeout=15)
    assert r.status_code == 422
