"""Publish a verified PR Windows Dev installer outside Actions artifact storage."""

import hashlib
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen

from modelscope.hub.api import HubApi


REPO_ID = 'alexyaojin/bisheng-work'
INSTALLER = Path('dist-dev/bisheng-work-dev-windows-x64-setup.exe')


def required_env(name):
    value = os.environ.get(name, '')
    if not value:
        raise RuntimeError(f'{name} is required')
    return value


def sha256(file):
    digest = hashlib.sha256()
    with file.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def verify_public_installer(url):
    for attempt in range(6):
        try:
            request = Request(url, headers={'Range': 'bytes=0-1', 'Accept-Encoding': 'identity'})
            with urlopen(request, timeout=30) as response:
                if response.read(2) == b'MZ':
                    return
                raise RuntimeError('Public installer URL did not return a Windows executable')
        except Exception:
            if attempt == 5:
                raise
            time.sleep(10)


def main():
    token = required_env('MODELSCOPE_TOKEN')
    pr_number = required_env('PR_NUMBER')
    head_sha = required_env('PR_HEAD_SHA')
    build_sha = required_env('BUILD_SHA')
    run_id = required_env('GITHUB_RUN_ID')
    if not pr_number.isdecimal() or not all(re.fullmatch(r'[0-9a-f]{40}', sha) for sha in (head_sha, build_sha)):
        raise RuntimeError('Invalid PR or commit identity')
    if not run_id.isdecimal():
        raise RuntimeError('Invalid workflow run ID')
    if not INSTALLER.is_file() or INSTALLER.stat().st_size < 1024 * 1024:
        raise RuntimeError(f'Missing or incomplete installer: {INSTALLER}')
    with INSTALLER.open('rb') as source:
        if source.read(2) != b'MZ':
            raise RuntimeError(f'Installer is not a Windows executable: {INSTALLER}')

    destination = f'releases/development/pr-{pr_number}/run-{run_id}'
    with tempfile.TemporaryDirectory(prefix='bisheng-work-dev-') as temporary:
        staging = Path(temporary)
        shutil.copy2(INSTALLER, staging / INSTALLER.name)
        manifest = {
            'channel': 'development',
            'pr': int(pr_number),
            'headSha': head_sha,
            'buildSha': build_sha,
            'runId': int(run_id),
            'installer': INSTALLER.name,
            'size': INSTALLER.stat().st_size,
            'sha256': sha256(INSTALLER),
        }
        (staging / 'build-info.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        HubApi().upload_folder(
            repo_id=REPO_ID,
            folder_path=str(staging),
            path_in_repo=destination,
            commit_message=f'PR #{pr_number} Windows Dev build {run_id}',
            token=token,
        )

    url = f'https://modelscope.cn/models/{REPO_ID}/resolve/master/{quote(destination)}/{INSTALLER.name}'
    verify_public_installer(url)
    print(f'Public Windows Dev installer: {url}')
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as output:
            output.write(f'## Windows Dev package\n\n[Download unsigned Windows x64 installer]({url})\n\n')
            output.write(f'PR #{pr_number}, head `{head_sha}`, workflow run `{run_id}`.\n')


if __name__ == '__main__':
    main()
