"""Compare completed runs without changing the original data or frozen rubric."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BASE = ROOT.parent
DATA = BASE.parents[1] / 'datasets/public-task-extraction-50-v1'
VARIANTS = ['luna-low', 'luna-medium', 'terra-low', 'sol-low']
EXCLUDED = {'PM-REAL-048'}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    baseline = BASE / 'luna-low-2026-09-08'
    original = json.loads((baseline / 'manifest.json').read_text())
    for name, expected in original['files_sha256'].items():
        assert sha(baseline / name) == expected, f'Baseline changed: {name}'
    splits = json.loads((DATA / 'splits.json').read_text())
    development = set(splits['development'])
    data_hash = sha(DATA / 'dataset.jsonl')
    reference = {p.stem: json.loads(p.read_text())
                 for p in (baseline / 'results').glob('*.json')}
    rows, cases = [], {}
    for variant in VARIANTS:
        folder = BASE / f'{variant}-2026-09-08'
        for name in ['prompt.md', 'schema.json', 'rubric.json']:
            assert sha(folder / name) == sha(baseline / name), (variant, name)
        runs = {p.stem: json.loads(p.read_text())
                for p in (folder / 'results').glob('*.json')}
        assert set(runs) == development, f'{variant}: incomplete or unexpected cases'
        for cid, run in runs.items():
            assert run['status'] == 'success', (variant, cid)
            assert run['response']['id'] == cid
            assert run['tool_calls'] == [], (variant, cid, 'tools')
            assert run['source_dataset_sha256'] == data_hash
            for key in ['prompt_sha256', 'schema_sha256']:
                assert run[key] == reference[cid][key], (variant, cid, key)
        score = json.loads((folder / 'scores.json').read_text())
        assert score['successful_structured_responses'] == len(development)
        kept = [d for d in score['details'] if d['id'] not in EXCLUDED]
        checks = [c for d in kept for c in d['checks']]
        row = {
            'variant': variant,
            'model_requested': score['model_requested'],
            'reasoning_effort': score['reasoning_effort'],
            'successful_responses': len(runs),
            'raw_cases_passed': score['cases_passing_all_selected_checks'],
            'raw_cases_total': len(development),
            'raw_checks_passed': score['selected_checks_passed'],
            'raw_checks_total': score['selected_checks_total'],
            'excluding_048_cases_passed': sum(d['all_checks_passed'] for d in kept),
            'excluding_048_cases_total': len(kept),
            'excluding_048_checks_passed': sum(c['passed'] for c in checks),
            'excluding_048_checks_total': len(checks),
            'raw_failed_cases': score['cases_requiring_review'],
            'clarification_cases': sum(r['response']['needs_clarification'] for r in runs.values()),
            'latency_includes_cli_startup_seconds': score['latency_includes_cli_startup_seconds'],
            'usage_totals': score['usage_totals'],
            'tool_calls': 0,
            'first_case_started_at': min(r['started_at'] for r in runs.values()),
        }
        rows.append(row)
        for detail in score['details']:
            cases.setdefault(detail['id'], {})[variant] = {
                'all_selected_checks_passed': detail['all_checks_passed'],
                'failed_checks': [c for c in detail['checks'] if not c['passed']],
                'response_file': f'../{folder.name}/results/{detail["id"]}.json',
            }
    result = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'interpretation': 'Provisional selected checks, not human-validated accuracy. One trial per case per configuration.',
        'excluded_from_secondary_score': sorted(EXCLUDED),
        'exclusion_predeclared_in': 'plan.json',
        'baseline_reused': True,
        'new_model_invocations': 105,
        'total_responses_compared': 140,
        'holdout_cases_executed': 0,
        'integrity': {'baseline_manifest_valid': True, 'identical_case_prompts': True,
                      'identical_schema_and_rubric': True, 'dataset_sha256': data_hash},
        'variants': rows,
        'cases': dict(sorted(cases.items())),
    }
    (ROOT / 'comparison.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(rows, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
