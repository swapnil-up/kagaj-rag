#!/usr/bin/env python3
"""
Run golden question evaluation against Kagaj RAG API.
"""
import json
import requests
import time
from datetime import datetime

API_BASE = "https://kagaj.swapnilupadhyay.com.np/api"

def load_questions(path="golden-questions.json"):
    with open(path) as f:
        return json.load(f)["questions"]

def ask_question(question, dataset_filter=None):
    """Ask a question to the RAG API."""
    payload = {"question": question}
    if dataset_filter:
        payload["dataset_filter"] = dataset_filter
    
    resp = requests.post(f"{API_BASE}/chat", json=payload, timeout=60)
    if resp.status_code == 429:
        return {"error": "rate_limited"}
    resp.raise_for_status()
    return resp.json()

def check_answer(result, expected):
    """Check if answer meets expectations."""
    checks = {
        "has_answer": bool(result.get("answer")),
        "has_citations": len(result.get("citations", [])) > 0,
        "citation_count": len(result.get("citations", [])),
    }
    
    answer = result.get("answer", "").lower()
    
    # Check must_contain
    for phrase in expected.get("must_contain", []):
        checks[f"contains_{phrase}"] = phrase.lower() in answer
    
    # Check must_not_contain
    for phrase in expected.get("must_not_contain", []):
        checks[f"not_contains_{phrase}"] = phrase.lower() not in answer
    
    # Check expected citation patterns
    citations = result.get("citations", [])
    for pattern in expected.get("expected_citations", []):
        # Simple pattern matching on doc_id
        found = any(pattern.replace("*", "") in c.get("doc_id", "") for c in citations)
        checks[f"citation_{pattern}"] = found
    
    return checks

def run_eval():
    questions = load_questions()
    results = []
    
    for q in questions:
        print(f"\n{'='*60}")
        print(f"Q: {q['question']}")
        print(f"Filter: {q.get('dataset_filter', 'all')}")
        
        result = ask_question(q["question"], q.get("dataset_filter"))
        
        if result.get("error") == "rate_limited":
            print("  RATE LIMITED - stopping")
            break
        
        checks = check_answer(result, q)
        
        print(f"  Answer: {result.get('answer', '')[:200]}...")
        print(f"  Citations: {len(result.get('citations', []))}")
        for check, passed in checks.items():
            status = "✓" if passed else "✗"
            print(f"  {status} {check}")
        
        results.append({
            "question_id": q["id"],
            "question": q["question"],
            "result": result,
            "checks": checks,
            "timestamp": datetime.now().isoformat()
        })
        
        time.sleep(2)  # Be nice to the API
    
    # Save results
    output = {
        "run_at": datetime.now().isoformat(),
        "total": len(results),
        "passed": sum(1 for r in results if all(r["checks"].values())),
        "results": results
    }
    
    with open(f"eval-results-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json", "w") as f:
        json.dump(output, f, indent=2)
    
    print(f"\n{'='*60}")
    print(f"SUMMARY: {output['passed']}/{output['total']} passed")
    
    return output

if __name__ == "__main__":
    run_eval()