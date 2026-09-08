"""Validate the delivered dataset; optionally compare with collection-time API cache."""
import argparse
import hashlib
import json
from pathlib import Path


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source-cache', type=Path, help='Optional original GitHub API response cache, keyed by API URL')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    records = [json.loads(x) for x in (root / 'dataset.jsonl').read_text().splitlines()]
    labels = [json.loads(x) for x in (root / 'annotations.jsonl').read_text().splitlines()]
    splits = json.loads((root / 'splits.json').read_text())
    manifest = json.loads((root / 'manifest.json').read_text())
    cache = json.loads(args.source_cache.read_text()) if args.source_cache else None
    assert len(records) == len(labels) == 50
    ids = [r['id'] for r in records]
    assert ids == [f'PM-REAL-{i:03d}' for i in range(1, 51)]
    assert ids == [a['id'] for a in labels]
    assert len({r['input']['thread_url'] for r in records}) == 50
    assert len({digest(json.dumps(r['input'], ensure_ascii=False)) for r in records}) == 50
    excerpt_count = 0
    for row, annotation in zip(records, labels):
        assert row['synthetic'] is False and row['data_origin'] == 'public_source'
        assert row['input']['prior_project_state'] is None
        assert row['input']['member_directory'] is None
        assert annotation['review_status'] == 'not_human_reviewed'
        assert annotation['automatic_db_mutation_gold'] is None
        title = row['input']['thread_title_at_collection']
        pairs = [(title, row['provenance']['thread_title'])]
        words = len(title.split())
        for ex in row['input']['excerpts']:
            assert ex['text_edits'] == []
            assert ex['author_account_type'] == 'User'
            assert ex['source_url'].startswith('https://github.com/')
            assert ex['created_at'] <= ex['updated_at']
            pairs.append((ex['text'], ex['provenance']))
            words += len(ex['text'].split())
            excerpt_count += 1
        assert words == row['provenance']['quoted_whitespace_words'] <= 25
        for text, proof in pairs:
            assert text and digest(text) == proof['excerpt_sha256']
            assert proof['end'] - proof['start'] == len(text)
            assert proof['matched_at_collection'] is True
            if cache is not None:
                original = cache[proof['api_url']][proof['field']]
                assert digest(original) == proof['source_field_sha256']
                assert original[proof['start']:proof['end']] == text
    assert excerpt_count == manifest['excerpts'] == 57
    dev, holdout = set(splits['development']), set(splits['holdout'])
    assert len(dev) == 35 and len(holdout) == 15
    assert not dev & holdout and dev | holdout == set(ids)
    dev_repos = {r['provenance']['repository'] for r in records if r['id'] in dev}
    holdout_repos = {r['provenance']['repository'] for r in records if r['id'] in holdout}
    assert not dev_repos & holdout_repos
    for filename, expected in manifest['files_sha256'].items():
        assert hashlib.sha256((root / filename).read_bytes()).hexdigest() == expected, filename
    print(json.dumps({'records': 50, 'excerpts': excerpt_count, 'unique_threads': 50,
                      'synthetic': 0, 'integrity': 'passed',
                      'source_substring_check': 'passed' if cache is not None else 'not_rerun; see verification.json',
                      'annotation_accuracy': 'not_human_reviewed'}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
