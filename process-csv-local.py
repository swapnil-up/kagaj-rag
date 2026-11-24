#!/usr/bin/env python3
"""
Local script to process CSV.gz files from kagaj repo and upload to Cloudflare Vectorize.
"""
import os
import sys
import gzip
import base64
import json
import csv
import io
import requests
from typing import List, Dict, Any

# Config from environment
CF_ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
CF_API_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
REPO_OWNER = "swapnil-up"
REPO_NAME = "kagaj"
DATASETS_PATH = "datasets"
INDEX_NAME = "kagaj-datasets"

if not all([CF_ACCOUNT_ID, CF_API_TOKEN, GITHUB_TOKEN]):
    print("Missing required env vars: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, GITHUB_TOKEN")
    sys.exit(1)

HEADERS = {
    "Authorization": f"Bearer {CF_API_TOKEN}",
    "Content-Type": "application/json",
}

GH_HEADERS = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "kagaj-local-processor",
    "Authorization": f"Bearer {GITHUB_TOKEN}",
}

BASE_URL = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}"
VECTORIZE_URL = f"{BASE_URL}/vectorize/v2/indexes/kagaj-datasets"

def get_github_file_sha(path: str) -> str:
    url = f"https://api.github.com/repos/{REPO_OWNER}/{REPO_NAME}/contents/{path}"
    resp = requests.get(url, headers={"Accept": "application/vnd.github.v3+json", "Authorization": f"Bearer {GITHUB_TOKEN}", "User-Agent": "kagaj-local"})
    resp.raise_for_status()
    return resp.json()["sha"]

def get_github_file_content(path: str) -> bytes:
    url = f"https://api.github.com/repos/swapnil-up/kagaj/contents/{path}"
    resp = requests.get(url, headers={"Accept": "application/vnd.github.v3+json", "Authorization": f"Bearer {GITHUB_TOKEN}", "User-Agent": "kagaj-local"})
    resp.raise_for_status()
    data = resp.json()
    if data.get("encoding") == "base64":
        return base64.b64decode(data["content"])
    return requests.get(data["download_url"]).content

def parse_csv_gz(content: bytes) -> List[Dict[str, str]]:
    """Parse CSV.gz and return list of row dicts."""
    decompressed = gzip.decompress(content)
    text = decompressed.decode('utf-8')
    reader = csv.DictReader(io.StringIO(text))
    return [row for row in reader]

def row_to_text(headers: List[str], row: Dict[str, str]) -> str:
    parts = []
    for h in headers:
        val = row.get(h, "")
        if val and val.strip():
            parts.append(f"{h}: {val}")
    return " | ".join(parts)

def embed_texts(texts: List[str]) -> List[List[float]]:
    """Embed texts using Cloudflare Workers AI."""
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/run/@cf/baai/bge-m3"
    resp = requests.post(
        url,
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
        json={"text": texts}
    )
    resp.raise_for_status()
    return resp.json()["result"]["data"]

def upsert_vectors(vectors: List[Dict[str, Any]]) -> bool:
    """Upsert vectors to Vectorize."""
    url = f"{BASE_URL}/vectorize/v2/indexes/kagaj-datasets/upsert"
    resp = requests.post(
        f"{BASE_URL}/vectorize/v2/indexes/kagaj-datasets/upsert",
        headers={"Authorization": f"Bearer {CF_API_TOKEN}", "Content-Type": "application/json"},
        json={"vectors": vectors}
    )
    if not resp.ok:
        print(f"Upsert failed: {resp.status_code} - {resp.text}")
        return False
    return True

def process_csv_file(file_path: str, dataset: str, batch_size: int = 50):
    """Process a single CSV.gz file."""
    print(f"Processing {file_path}...")
    
    # Get file info
    sha = get_github_file_sha(file_path)
    content = get_github_file_content(file_path)
    rows = parse_csv_gz(content)
    
    if len(rows) < 1:
        print(f"  No data rows")
        return 0
    
    # Get headers from first row keys
    first_row = rows[0]
    headers = list(first_row.keys())
    
    # Convert rows to text
    texts = []
    for row in rows:
        text = row_to_text(headers, row)
        if text.strip():
            texts.append(text)
    
    print(f"  Total rows: {len(texts)}")
    
    # Process in batches
    total_embedded = 0
    for i in range(0, len(texts), 50):
        batch = texts[i:i+50]
        print(f"  Embedding batch {i//50 + 1}/{(len(texts)-1)//50 + 1}...")
        
        embeddings = embed_texts(batch)
        
        vectors = []
        for j, (text, emb) in enumerate(zip(texts[i:i+50], embeddings)):
            idx = i + j
            vectors.append({
                "id": f"{file_path}-{idx}",
                "values": emb,
                "metadata": {
                    "doc_id": f"{file_path.split('/')[-1].replace('.csv.gz', '')}-{idx}",
                    "dataset": "govweb",
                    "type": "govweb_infra",
                    "title": f"Row {idx}",
                    "url": f"https://github.com/swapnil-up/kagaj/blob/main/{file_path}#L{idx+2}",
                    "text": text[:1000],
                }
            })
        
        success = upsert_vectors(vectors)
        if not success:
            print(f"  Failed to upsert batch")
            return total_embedded
        
        total_embedded += len(vectors)
        print(f"  Embedded {len(vectors)} vectors")
    
    print(f"  Completed: {total_embedded} vectors embedded")
    return total_embedded

def main():
    # CSV files to process
    csv_files = [
        "datasets/govweb/reachability.csv.gz",
        "datasets/govweb/entities.csv.gz",
        "datasets/govweb/attribution.csv.gz",
        "datasets/govweb/sites.csv.gz",
        "datasets/govweb/operators.csv.gz",
        "datasets/govweb/entity_hosting.csv.gz",
        "datasets/govweb/hosting.csv.gz",
        "datasets/govweb/dns_mail.csv.gz",
        "datasets/govweb/globalping.csv.gz",
        "datasets/govweb/http_headers.csv.gz",
        "datasets/govweb/robots.csv.gz",
        "datasets/govweb/third_party_scripts.csv.gz",
        "datasets/govweb/tls.csv.gz",
    ]
    
    # Check which already have SHA in cache (skip if unchanged)
    # For now, process all
    total = 0
    for f in csv_files:
        try:
            count = process_csv_file(f, "govweb")
            total += count
            print(f"✓ {f}: {count} vectors")
        except Exception as e:
            print(f"✗ {f}: {e}")
    
    print(f"\nTotal vectors embedded: {total}")

if __name__ == "__main__":
    main()
