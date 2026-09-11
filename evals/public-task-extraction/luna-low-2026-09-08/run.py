"""One fresh, tool-disabled Codex CLI invocation per case, using ChatGPT login."""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parents[2]
DATA = PROJECT / 'datasets/public-task-extraction-50-v1'
MODEL = 'gpt-5.6-luna'
WORK = Path('/tmp/projectmate-luna-eval')


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def run_case(row):
    cid = row['id']
    destination = ROOT / 'results' / (cid + '.json')
    model_input = {
        'id': cid,
        'thread_url': row['input']['thread_url'],
        'thread_title_at_collection': row['input']['thread_title_at_collection'],
        'excerpts': [{k: ex[k] for k in ('text', 'author_login', 'created_at', 'updated_at')}
                     for ex in row['input']['excerpts']],
        'prior_project_state': None,
        'member_directory': None,
    }
    payload = ROOT.joinpath('prompt.md').read_text() + '\nCASE DATA:\n' + json.dumps(model_input, ensure_ascii=False)
    if destination.exists():
        old = json.loads(destination.read_text())
        same_input = (old['prompt_sha256'] == digest(payload)
                      and old['schema_sha256'] == digest((ROOT / 'schema.json').read_text())
                      and old['model_requested'] == MODEL
                      and old['reasoning_effort'] == 'low')
        if old['status'] == 'success' and same_input:
            return cid, 'cached', old['elapsed_seconds']
        raise RuntimeError(f'{cid} has a failed result or changed input; use a new run directory.')
    cmd = [shutil.which('codex'), 'exec', '--model', MODEL, '--ignore-user-config',
           '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
           '--cd', str(WORK), '--json', '--color', 'never',
           '--output-schema', str(ROOT / 'schema.json'),
           '-c', 'model_reasoning_effort="low"', '-c', 'web_search="disabled"']
    for flag in ('shell_tool', 'multi_agent', 'apps', 'plugins', 'browser_use',
                 'computer_use', 'in_app_browser', 'image_generation', 'goals',
                 'hooks', 'memories', 'skill_search', 'tool_suggest'):
        cmd.extend(['--disable', flag])
    cmd.append('-')
    env = os.environ.copy()
    for key in ('OPENAI_API_KEY', 'CODEX_API_KEY'):
        env.pop(key, None)
    started = datetime.now(timezone.utc).isoformat()
    t0 = time.monotonic()
    result = subprocess.run(cmd, input=payload, text=True, capture_output=True,
                            env=env, timeout=180)
    events = []
    for line in result.stdout.splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    finals = [e['item']['text'] for e in events
              if e.get('type') == 'item.completed' and e.get('item', {}).get('type') == 'agent_message']
    used_tools = [e['item'].get('type') for e in events
                  if e.get('type') == 'item.completed' and e.get('item', {}).get('type') not in ('agent_message', 'reasoning')]
    usage = next((e.get('usage') for e in reversed(events) if e.get('type') == 'turn.completed'), None)
    response, parse_error = None, None
    try:
        response = json.loads(finals[-1]) if finals else None
    except json.JSONDecodeError as exc:
        parse_error = str(exc)
    success = result.returncode == 0 and response is not None and response.get('id') == cid and not used_tools
    record = {
        'id': cid, 'model_requested': MODEL, 'reasoning_effort': 'low',
        'authentication': 'existing_chatgpt_login; API-key environment variables removed',
        'started_at': started, 'elapsed_seconds': round(time.monotonic() - t0, 3),
        'status': 'success' if success else 'failed', 'exit_code': result.returncode,
        'prompt_sha256': digest(payload),
        'schema_sha256': digest((ROOT / 'schema.json').read_text()),
        'source_dataset_sha256': hashlib.sha256((DATA / 'dataset.jsonl').read_bytes()).hexdigest(),
        'usage': usage, 'tool_calls': used_tools, 'response': response,
        'parse_error': parse_error,
        'errors': [e for e in events if e.get('type') in ('error', 'turn.failed')],
    }
    if not success:
        record['stderr_tail'] = result.stderr[-3000:]
    destination.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
    return cid, record['status'], record['elapsed_seconds']


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--ids', nargs='+')
    group.add_argument('--development', action='store_true')
    parser.add_argument('--workers', type=int, default=2, choices=(1, 2, 3))
    args = parser.parse_args()
    (ROOT / 'results').mkdir(exist_ok=True)
    WORK.mkdir(exist_ok=True)
    rows = [json.loads(x) for x in (DATA / 'dataset.jsonl').read_text().splitlines()]
    development = set(json.loads((DATA / 'splits.json').read_text())['development'])
    selected = development if args.development else set(args.ids)
    assert selected <= development, 'Only the development split is authorized for this pilot.'
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs = [pool.submit(run_case, row) for row in rows if row['id'] in selected]
        for job in as_completed(jobs):
            print(*job.result(), flush=True)


if __name__ == '__main__':
    main()
