"""Persistent, local web archive, separate from the agent's scratch database."""
import hashlib
import json
import sqlite3
from contextlib import closing
from datetime import date, datetime, timezone


class WebStore:
    def __init__(self, path):
        self.path = str(path)
        with closing(sqlite3.connect(self.path)) as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS web_jobs (
                    id INTEGER PRIMARY KEY, identity TEXT UNIQUE NOT NULL,
                    company TEXT, position TEXT, posting TEXT, deadline TEXT,
                    source_url TEXT, result TEXT NOT NULL,
                    deleted_at TEXT,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
                CREATE TABLE IF NOT EXISTS web_tasks (
                    id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES web_jobs(id),
                    title TEXT NOT NULL, due_date TEXT NOT NULL, status TEXT DEFAULT 'todo',
                    UNIQUE(job_id, title, due_date));
                CREATE TABLE IF NOT EXISTS job_catalog (
                    id INTEGER PRIMARY KEY,
                    source TEXT NOT NULL, source_id TEXT NOT NULL, source_name TEXT NOT NULL,
                    company TEXT NOT NULL DEFAULT '', position TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '',
                    location TEXT NOT NULL DEFAULT '', job_type TEXT NOT NULL DEFAULT '',
                    salary TEXT NOT NULL DEFAULT '', career TEXT NOT NULL DEFAULT '',
                    deadline TEXT NOT NULL DEFAULT '', posted_at TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(source, source_id));
                CREATE TABLE IF NOT EXISTS job_catalog_interests (
                    job_id INTEGER NOT NULL REFERENCES job_catalog(id) ON DELETE CASCADE,
                    category TEXT NOT NULL,
                    PRIMARY KEY(job_id, category));
                CREATE INDEX IF NOT EXISTS idx_job_catalog_interest
                    ON job_catalog_interests(category, job_id);
                CREATE TABLE IF NOT EXISTS job_sync_state (
                    category TEXT PRIMARY KEY, last_synced_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS job_preferences (
                    name TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS web_resume_profile (
                    id INTEGER PRIMARY KEY CHECK(id=1),
                    content TEXT NOT NULL,
                    filename TEXT NOT NULL DEFAULT '직접 입력',
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
                CREATE TABLE IF NOT EXISTS web_resumes (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    content TEXT NOT NULL,
                    filename TEXT NOT NULL DEFAULT '직접 입력',
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            ''')
            if 'deleted_at' not in {row[1] for row in db.execute('PRAGMA table_info(web_tasks)')}:
                db.execute('ALTER TABLE web_tasks ADD COLUMN deleted_at TEXT')
            if 'deleted_at' not in {row[1] for row in db.execute('PRAGMA table_info(web_jobs)')}:
                db.execute('ALTER TABLE web_jobs ADD COLUMN deleted_at TEXT')
            legacy_resume = db.execute(
                'SELECT content,filename,updated_at FROM web_resume_profile WHERE id=1').fetchone()
            has_resumes = db.execute('SELECT 1 FROM web_resumes LIMIT 1').fetchone()
            migrated = db.execute(
                "SELECT 1 FROM job_preferences WHERE name='resume_collection_migrated'").fetchone()
            if not migrated:
                if legacy_resume and not has_resumes:
                    cursor = db.execute('''INSERT INTO web_resumes(name,content,filename,updated_at)
                        VALUES('기본 이력서',?,?,?)''', tuple(legacy_resume))
                    db.execute('''INSERT INTO job_preferences(name,value) VALUES('active_resume_id',?)
                        ON CONFLICT(name) DO NOTHING''', (str(cursor.lastrowid),))
                db.execute("INSERT INTO job_preferences(name,value) VALUES('resume_collection_migrated','1')")
            db.commit()

    def query(self, sql, args=()):
        with closing(sqlite3.connect(self.path)) as db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA foreign_keys=ON')
            rows = db.execute(sql, args).fetchall()
            db.commit()
            return [dict(row) for row in rows]

    def upsert_catalog(self, items, category):
        """Store provider results and associate every result with its selected interest."""
        clean = []
        columns = ('source', 'source_id', 'source_name', 'company', 'position', 'description',
                   'source_url', 'location', 'job_type', 'salary', 'career', 'deadline', 'posted_at')
        for item in items:
            row = {key: str(item.get(key, '') or '').strip()[:40000 if key == 'description' else 4000]
                   for key in columns}
            has_public_source = row['source_url'].startswith('https://')
            is_local_demo = (row['source'] == 'demo' and not row['source_url']
                             and len(row['description']) >= 30)
            if row['source'] and row['source_id'] and (has_public_source or is_local_demo):
                clean.append(row)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('PRAGMA foreign_keys=ON')
            db.execute('BEGIN IMMEDIATE')
            for item in clean:
                db.execute('''INSERT INTO job_catalog
                    (source,source_id,source_name,company,position,description,source_url,location,
                     job_type,salary,career,deadline,posted_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
                    ON CONFLICT(source,source_id) DO UPDATE SET
                    source_name=excluded.source_name,company=excluded.company,position=excluded.position,
                    description=CASE WHEN excluded.description='' THEN job_catalog.description ELSE excluded.description END,
                    source_url=excluded.source_url,location=excluded.location,job_type=excluded.job_type,
                    salary=excluded.salary,career=excluded.career,deadline=excluded.deadline,
                    posted_at=excluded.posted_at,updated_at=CURRENT_TIMESTAMP''',
                    tuple(item[key] for key in columns))
                job_id = db.execute('SELECT id FROM job_catalog WHERE source=? AND source_id=?',
                                    (item['source'], item['source_id'])).fetchone()[0]
                db.execute('INSERT OR IGNORE INTO job_catalog_interests(job_id,category) VALUES(?,?)',
                           (job_id, category))
            db.commit()
        return len(clean)

    def catalog(self, category, limit=200):
        limit = max(1, min(int(limit), 500))
        return self.query('''SELECT j.id,j.source,j.source_id,j.source_name,j.company,j.position,
            j.source_url,j.location,j.job_type,j.salary,j.career,j.deadline,
            j.posted_at,j.updated_at FROM job_catalog j
            JOIN job_catalog_interests i ON i.job_id=j.id
            WHERE i.category=? ORDER BY
            CASE WHEN j.deadline='' THEN 1 ELSE 0 END,j.deadline ASC,j.posted_at DESC,j.id DESC LIMIT ?''',
            (category, limit))

    def catalog_detail(self, job_id):
        rows = self.query('SELECT * FROM job_catalog WHERE id=?', (job_id,))
        if not rows:
            raise ValueError('채용공고를 찾을 수 없습니다.')
        job = rows[0]
        job['interests'] = [row['category'] for row in self.query(
            'SELECT category FROM job_catalog_interests WHERE job_id=? ORDER BY category', (job_id,))]
        return job

    def update_catalog_description(self, job_id, description):
        text = str(description or '').strip()[:40000]
        if len(text) < 30:
            raise ValueError('공고 상세 내용이 너무 짧아 이력서와 비교할 수 없습니다.')
        rows = self.query('''UPDATE job_catalog SET description=?,updated_at=CURRENT_TIMESTAMP
            WHERE id=? RETURNING id''', (text, job_id))
        if not rows:
            raise ValueError('채용공고를 찾을 수 없습니다.')
        return self.catalog_detail(job_id)

    def set_sync_time(self, category, timestamp=None):
        timestamp = timestamp or datetime.now(timezone.utc).isoformat(timespec='seconds')
        self.query('''INSERT INTO job_sync_state(category,last_synced_at) VALUES(?,?)
            ON CONFLICT(category) DO UPDATE SET last_synced_at=excluded.last_synced_at''',
            (category, timestamp))
        return timestamp

    def sync_time(self, category):
        rows = self.query('SELECT last_synced_at FROM job_sync_state WHERE category=?', (category,))
        return rows[0]['last_synced_at'] if rows else None

    def preference(self, name, default=''):
        rows = self.query('SELECT value FROM job_preferences WHERE name=?', (name,))
        return rows[0]['value'] if rows else default

    def set_preference(self, name, value):
        self.query('''INSERT INTO job_preferences(name,value) VALUES(?,?)
            ON CONFLICT(name) DO UPDATE SET value=excluded.value''', (name, str(value)))

    def resume_collection(self):
        resumes = self.query('''SELECT id,name,filename,updated_at FROM web_resumes
            ORDER BY updated_at DESC,id DESC''')
        ids = {row['id'] for row in resumes}
        try:
            selected_id = int(self.preference('active_resume_id'))
        except (TypeError, ValueError):
            selected_id = None
        if selected_id not in ids:
            selected_id = resumes[0]['id'] if resumes else None
            self.set_preference('active_resume_id', selected_id or '')
        return {'resumes': resumes, 'selected_resume_id': selected_id}

    def selected_resume(self):
        selected_id = self.resume_collection()['selected_resume_id']
        if selected_id is None:
            return None
        rows = self.query('''SELECT id,name,content,filename,updated_at FROM web_resumes WHERE id=?''',
                          (selected_id,))
        return rows[0] if rows else None

    def select_resume(self, payload):
        try:
            resume_id = int(payload.get('resume_id'))
        except (TypeError, ValueError):
            raise ValueError('사용할 이력서를 선택해주세요.')
        rows = self.query('SELECT id FROM web_resumes WHERE id=?', (resume_id,))
        if not rows:
            raise ValueError('이력서를 찾을 수 없습니다.')
        self.set_preference('active_resume_id', resume_id)
        return {'resume': self.selected_resume(), **self.resume_collection()}

    def save_resume(self, payload):
        content = payload.get('content')
        if not isinstance(content, str):
            raise ValueError('이력서 내용을 입력해주세요.')
        content = content.strip()
        if not 30 <= len(content) <= 40000:
            raise ValueError('이력서는 30~40,000자로 입력해주세요.')
        name = str(payload.get('name') or '').strip()[:80]
        if not name:
            raise ValueError('이력서 이름을 입력해주세요.')
        filename = str(payload.get('filename') or '직접 입력').strip()[:160] or '직접 입력'
        resume_id = payload.get('resume_id')
        if resume_id not in (None, ''):
            try:
                resume_id = int(resume_id)
            except (TypeError, ValueError):
                raise ValueError('수정할 이력서를 찾을 수 없습니다.')
            rows = self.query('''UPDATE web_resumes SET name=?,content=?,filename=?,updated_at=CURRENT_TIMESTAMP
                WHERE id=? RETURNING id,name,content,filename,updated_at''',
                (name, content, filename, resume_id))
            if not rows:
                raise ValueError('수정할 이력서를 찾을 수 없습니다.')
            saved = rows[0]
        else:
            rows = self.query('''INSERT INTO web_resumes(name,content,filename)
                VALUES(?,?,?) RETURNING id,name,content,filename,updated_at''', (name, content, filename))
            saved = rows[0]
        self.set_preference('active_resume_id', saved['id'])
        return {'resume': saved, **self.resume_collection()}

    def delete_resume(self, payload):
        try:
            resume_id = int(payload.get('resume_id'))
        except (TypeError, ValueError):
            raise ValueError('삭제할 이력서를 선택해주세요.')
        rows = self.query('DELETE FROM web_resumes WHERE id=? RETURNING id', (resume_id,))
        if not rows:
            raise ValueError('삭제할 이력서를 찾을 수 없습니다.')
        collection = self.resume_collection()
        return {'resume': self.selected_resume(), **collection}

    def resume_profile(self):
        """Backward-compatible accessor for the currently selected resume."""
        return self.selected_resume()

    def resume_by_id(self, resume_id):
        rows = self.query('SELECT id,name,content,filename,updated_at FROM web_resumes WHERE id=?',
                          (resume_id,))
        if not rows:
            raise ValueError('이력서를 찾을 수 없습니다.')
        return rows[0]

    def save_resume_profile(self, payload):
        """Backward-compatible save endpoint for older browser clients."""
        collection = self.resume_collection()
        active = collection['selected_resume_id']
        current = self.selected_resume()
        return self.save_resume({**payload, 'name': payload.get('name') or (current or {}).get('name') or '기본 이력서',
                                 'resume_id': payload.get('resume_id') or active})['resume']

    def save(self, payload, result):
        fields = [str(payload.get(k, '')).strip() for k in ('company', 'position', 'posting')]
        identity = hashlib.sha256(json.dumps([' '.join(x.split()).casefold() for x in fields]).encode()).hexdigest()
        return self.query('''INSERT INTO web_jobs(identity,company,position,posting,deadline,source_url,result)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(identity) DO UPDATE SET
            deadline=excluded.deadline,source_url=excluded.source_url,result=excluded.result,
            deleted_at=NULL,updated_at=CURRENT_TIMESTAMP RETURNING id''',
            (identity, *fields, str(payload.get('deadline', ''))[:20],
             str(payload.get('source_url', ''))[:2000], json.dumps(result, ensure_ascii=False)))[0]['id']

    def jobs(self):
        return self.query('''SELECT id,company,position,deadline,updated_at FROM web_jobs
            WHERE deleted_at IS NULL ORDER BY updated_at DESC,id DESC''')

    def delete_job(self, payload):
        job_id = payload.get('job_id')
        if type(job_id) is not int or job_id <= 0:
            raise ValueError('삭제할 보관 공고를 선택해주세요.')
        rows = self.query('''UPDATE web_jobs SET deleted_at=CURRENT_TIMESTAMP
            WHERE id=? AND deleted_at IS NULL RETURNING id''', (job_id,))
        if not rows:
            raise ValueError('보관함에서 공고를 찾을 수 없습니다.')
        return {'ok': True, 'deleted_id': job_id}

    def detail(self, job_id):
        rows = self.query('SELECT * FROM web_jobs WHERE id=? AND deleted_at IS NULL', (job_id,))
        if not rows:
            raise ValueError('공고를 찾을 수 없습니다.')
        job = rows[0]
        job['result'] = json.loads(job['result'])
        job['tasks'] = self.query('SELECT * FROM web_tasks WHERE job_id=? AND deleted_at IS NULL ORDER BY id', (job_id,))
        return job

    def tasks(self):
        return self.query('''SELECT t.*,j.company,j.position FROM web_tasks t
            JOIN web_jobs j ON j.id=t.job_id WHERE t.deleted_at IS NULL ORDER BY t.status DESC,t.due_date,t.id''')

    def add_task(self, payload):
        if payload.get('approved') is not True:
            raise ValueError('할 일 내용을 확인한 뒤 등록을 승인해주세요.')
        job = self.detail(payload.get('job_id'))
        title = str(payload.get('title', '')).strip()
        if not 1 <= len(title) <= 300:
            raise ValueError('할 일은 1~300자로 입력해주세요.')
        due = date.fromisoformat(str(payload.get('due_date', '')))
        if job['deadline'] and due > date.fromisoformat(job['deadline']):
            raise ValueError('할 일 기한은 지원 마감일 이후로 지정할 수 없습니다.')
        # Serialize the check and insert, including requests from multiple tabs.
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('BEGIN IMMEDIATE')
            existing = db.execute('SELECT id,due_date FROM web_tasks WHERE job_id=? AND title=? AND deleted_at IS NULL ORDER BY id LIMIT 1', (job['id'], title)).fetchone()
            if existing:
                db.commit()
                return {'ok': True, 'already_registered': True, 'task_id': existing[0], 'due_date': existing[1]}
            row = db.execute('''INSERT INTO web_tasks(job_id,title,due_date) VALUES(?,?,?)
                ON CONFLICT(job_id,title,due_date) DO UPDATE SET deleted_at=NULL,status='todo'
                RETURNING id''', (job['id'], title, due.isoformat())).fetchone()
            db.commit()
        return {'ok': True, 'task_id': row[0], 'due_date': due.isoformat()}

    def delete_tasks(self, payload):
        ids = payload.get('task_ids')
        if not isinstance(ids, list) or not 1 <= len(ids) <= 500 or any(type(i) is not int or i <= 0 for i in ids):
            raise ValueError('삭제할 할 일을 선택해주세요. 한 번에 최대 500개까지 가능합니다.')
        ids = list(set(ids))
        placeholders = ','.join('?' for _ in ids)
        rows = self.query(f'UPDATE web_tasks SET deleted_at=CURRENT_TIMESTAMP WHERE deleted_at IS NULL AND id IN ({placeholders}) RETURNING id', tuple(ids))
        return {'ok': True, 'deleted_count': len(rows)}

    def set_status(self, payload):
        if payload.get('status') not in ('todo', 'done'):
            raise ValueError('잘못된 진행 상태입니다.')
        rows = self.query('UPDATE web_tasks SET status=? WHERE id=? AND deleted_at IS NULL RETURNING id',
                          (payload['status'], payload.get('task_id')))
        if not rows:
            raise ValueError('할 일을 찾을 수 없습니다.')
        return {'ok': True}
