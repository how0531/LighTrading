import pytest
import requests

def test_api_login():
    try:
        response = requests.post("http://127.0.0.1:8000/api/login", json={"username": "test", "password": "password"})
        assert response.status_code in [200, 401], f"Unexpected status code: {response.status_code}"
    except requests.exceptions.ConnectionError:
        pytest.fail("Backend API is unreachable (ConnectionError)")
