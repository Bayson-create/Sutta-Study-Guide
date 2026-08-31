#!/usr/bin/env python3
import argparse, gzip, hashlib, json, pathlib

def read(p):
    data=p.read_bytes()
    if data[:2]==b'\x1f\x8b': data=gzip.decompress(data)
    return json.loads(data)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('directory',type=pathlib.Path); ap.add_argument('--expected-surface-concepts',type=int,default=14474); ap.add_argument('--expected-raw-relations',type=int,default=818110); args=ap.parse_args()
    out=args.directory; m=read(out/'manifest.json'); errors=[]
    counts=m.get('counts',{})
    if counts.get('surface_concepts')!=args.expected_surface_concepts: errors.append('surface concept count')
    if counts.get('surface_relations')!=args.expected_raw_relations: errors.append('surface relation count')
    if counts.get('concept_types')!=8: errors.append('concept type count')
    if counts.get('relation_types')!=15: errors.append('relation type count')
    concepts=read(out/'concepts.json.gz')
    if len(concepts)!=counts.get('canonical_concepts'): errors.append('canonical concept file count')
    if any(not x.get('label_zh') or not x.get('label_en') for x in concepts): errors.append('missing translation labels')
    if m.get('ai', {}).get('status') == 'not_run':
        if any(x.get('ai_audit_status') != 'not_run' or x.get('v2_audit_status') != 'not_ai_audited' for x in concepts):
            errors.append('concept AI audit markers')
    seen=set(); raw=0; raw_rows=[]
    for p in sorted((out/'raw-relations').glob('*.json.gz')):
        for x in read(p):
            rid=x.get('relation_id')
            if rid in seen: errors.append('duplicate raw relation '+str(rid))
            seen.add(rid); raw+=1; raw_rows.append(x)
    if raw!=args.expected_raw_relations: errors.append(f'raw relation files {raw}')
    relations=[]
    for p in sorted((out/'relations').glob('*.json.gz')):
        if p.name=='index.json.gz': continue
        relations.extend(read(p))
    unique={x.get('relation_id'):x for x in relations}
    if len(unique)!=counts.get('canonical_relations'): errors.append('canonical relation count')
    if any(x.get('evidence_status')!='verified' for x in unique.values()): errors.append('relation evidence')
    if m.get('ai', {}).get('status') == 'not_run' and any(x.get('ai_audit_status') != 'not_run' or x.get('v2_audit_status') != 'not_ai_audited' for x in unique.values()):
        errors.append('relation AI audit markers')
    if m.get('ai', {}).get('status') == 'not_run' and any(x.get('v2_audit_status') != 'not_ai_audited' for x in raw_rows):
        errors.append('raw relation AI audit markers')
    adjacency_index = read(out/'adjacency'/'index.json.gz')
    adjacency_rows = 0
    adjacency_relation_ids = {}
    adjacency_degree = {}
    adjacency_concepts = set()
    for p in sorted((out/'adjacency').glob('*.json.gz')):
        if p.name == 'index.json.gz':
            continue
        bucket = p.stem.removesuffix('.json')
        payload = read(p)
        for cid, rows in payload.items():
            adjacency_concepts.add(cid)
            if adjacency_index.get('shards', {}).get(cid) != bucket:
                errors.append('adjacency shard mismatch '+str(cid))
            adjacency_degree[cid] = len(rows)
            for row in rows:
                adjacency_rows += 1
                rid = row.get('relation_id')
                adjacency_relation_ids.setdefault(rid, []).append(cid)
                if row.get('source') != cid and row.get('target') != cid:
                    errors.append('adjacency endpoint mismatch '+str(rid))
    if adjacency_index.get('relation_count') != counts.get('canonical_relations'):
        errors.append('adjacency relation count')
    if adjacency_index.get('row_count') != adjacency_rows or adjacency_rows != 2 * counts.get('canonical_relations', 0):
        errors.append('adjacency row count')
    if set(adjacency_relation_ids) != set(unique):
        errors.append('adjacency relation coverage')
    if any(len(cids) != 2 or cids[0] == cids[1] for cids in adjacency_relation_ids.values()):
        errors.append('adjacency relation endpoints')
    concepts_by_id = {x.get('concept_id'): x for x in concepts}
    if set(adjacency_concepts) - set(concepts_by_id):
        errors.append('adjacency unknown concepts')
    if any(int(x.get('relation_count') or 0) != adjacency_degree.get(x.get('concept_id'), 0) for x in concepts):
        errors.append('concept adjacency degree')
    hashes=[]
    for p in sorted(out.rglob('*')):
        if p.is_file() and p.name!='manifest.json': hashes.append((p.relative_to(out).as_posix(),hashlib.sha256(p.read_bytes()).hexdigest()))
    listed={x.get('path'):x.get('sha256') for x in m.get('files',[])}
    if listed!={k:v for k,v in hashes}: errors.append('manifest hashes')
    print(json.dumps({'ok':not errors,'errors':errors,'counts':counts,'quality_gate':m.get('quality_gate')},ensure_ascii=False))
    raise SystemExit(0 if not errors else 1)
if __name__=='__main__': main()
