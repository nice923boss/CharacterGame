import httpx
from _env import api_key

r = httpx.get("https://integrate.api.nvidia.com/v1/models", headers={"Authorization": "Bearer " + api_key()}, timeout=30)
ids = sorted(m["id"] for m in r.json()["data"])
print(len(ids))
for i in ids:
    print(i)
