"""Compare build inputs with the final 0.12.0 packaged resources."""
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist/installer-0.12.0'
RESOURCES = DIST / 'win-unpacked/resources'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest().upper()


def compare_tree(source, target):
    original = {p.relative_to(source): p for p in source.rglob('*') if p.is_file()}
    packaged = {p.relative_to(target): p for p in target.rglob('*') if p.is_file()}
    assert original.keys() == packaged.keys(), f'File list mismatch: {source}'
    for relative, path in original.items():
        assert digest(path) == digest(packaged[relative]), f'Hash mismatch: {relative}'
    return {'files': len(original), 'sha256_equal': True}


if __name__ == '__main__':
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    artifact = package['build']['win']['artifactName'].replace('${version}', package['version']).replace('${ext}', 'exe')
    installer = DIST / artifact
    service = ROOT / 'backend/dist/workbench-service.exe'
    assert digest(service) == digest(RESOURCES / 'backend/workbench-service.exe')
    result = {
        'installer': {'bytes': installer.stat().st_size, 'sha256': digest(installer)},
        'backend_sha256': digest(service),
        'pdf_engine_sha256': digest(RESOURCES / 'pdf-engine/workbench-pdf-engine.exe'),
        'engine': compare_tree(ROOT / 'backend/dist/workbench-pdf-engine', RESOURCES / 'pdf-engine'),
        'assets': compare_tree(ROOT / 'backend/pdf_engine_assets/babeldoc', RESOURCES / 'pdf-engine-assets/babeldoc'),
        'source': compare_tree(ROOT / 'backend/pdf-engine-source', RESOURCES / 'pdf-engine-source'),
    }
    destination = ROOT / '.review/distribution-0.12.json'
    destination.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
