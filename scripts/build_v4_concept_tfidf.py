#!/usr/bin/env python3
"""Build an auditable Pali TF-IDF concept layer from V4 and Azure commentary-links-v5.

The builder never falls back to commentary-links-v2.  Release mode requires a
complete v5 snapshot and a completed AI audit.  It uses only the Python stdlib.
"""
from __future__ import annotations

import argparse, collections, datetime as dt, gzip, hashlib, html, json, math, os
from concurrent.futures import ThreadPoolExecutor, as_completed
import pathlib, re, statistics, sys, time, unicodedata, urllib.request, zipfile

V5_FORMAT = "tipitaka-commentary-links/v5"
OUT_FORMAT = "tipitaka-concept-tfidf/v1"
ROOTS = "https://suttastudyguidestor.blob.core.windows.net/tipitaka-public/tipitaka/commentary-links-v5/roots"
TOKEN_RE = re.compile(r"[A-Za-zĀĪŪṄÑṬḌṆḶṂṁāīūṅñṭḍṇḷṃ]+", re.UNICODE)
TAG_RE = re.compile(r"<[^>]*>")
SENTENCE_RE = re.compile(r"(?<=[.!?;:।॥])\s+|\n+")
HEAD_RENDS = {"title", "chapter", "subhead", "centre"}
CORE = {"buddha","dhamma","saṅgha","sīla","samādhi","paññā","sati","jhāna","nibbāna","dukkha","anicca","anattā","kamma","mettā","karuṇā","vipassanā","samatha","magga","phala","citta","rūpa","vedanā","saññā","saṅkhāra","viññāṇa"}
STOPWORDS = {"atha","ca","ce","eva","evaṃ","iti","kho","nu","vā","ve","hi","pi","pana","tassa","tasmā","tesaṃ","tesu","so","sā","taṃ","te","yaṃ","ye","yā","yo","imaṃ","imasmiṃ","idha","ettha","kathaṃ","kiṃ","ko","kā","na","no","mā","me","mayhaṃ","bhante","bhikkhave","bhikkhu","āha","āhu","hoti","honti","vattabbaṃ","vuccati","nāma","atthi","santi","ahaṃ","tvaṃ","tumhe","amhākaṃ","assa","assā","assu","assāmi","siyā","siyuṃ","yathā","tathā","yena","tena","yasmā","tasmā","sace","seyyathāpi","ettakaṃ","ettāvatā","punapi","puna","idāni","adya","handa","sādhu","āma"}
STRUCTURAL_SUFFIXES = ("vaggo","vaggaṃ","nipāto","nipātaṃ","vaṇṇanā","vaṇṇanaṃ","kaṇḍaṃ","kaṇḍo","pāḷi","pāḷiyaṃ","nayo","nayassa","kathāvaṇṇanā")

def sha(data: bytes) -> str: return hashlib.sha256(data).hexdigest()
def stable(obj) -> bytes: return (json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
def norm(token: str) -> str:
    return unicodedata.normalize("NFC", token).lower().replace("ṁ", "ṃ").strip("-'’")
def usable_term(token: str) -> bool:
    token=norm(token)
    return bool(token and token in CORE or (len(token)>=4 and token not in STOPWORDS and not token.endswith(STRUCTURAL_SUFFIXES)))
def plain(value) -> str: return html.unescape(TAG_RE.sub(" ", str(value or ""))).strip()
def read_json_bytes(data: bytes):
    if data[:2] == b"\x1f\x8b": data = gzip.decompress(data)
    return json.loads(data)
def zip_member(z, suffix):
    names = [n for n in z.namelist() if n.endswith(suffix) and not n.startswith("__MACOSX/")]
    if len(names) != 1: raise RuntimeError(f"expected one {suffix}, got {len(names)}")
    return names[0]
def write_json(path: pathlib.Path, obj, compress=False):
    path.parent.mkdir(parents=True, exist_ok=True); data = stable(obj)
    if compress: data = gzip.compress(data, mtime=0)
    path.write_bytes(data); return {"path": path.name, "bytes": len(data), "sha256": sha(data)}

def fetch_v5(works, cache: pathlib.Path, offline=False):
    cache.mkdir(parents=True, exist_ok=True); records=[]; payloads={}
    for index, work in enumerate(works, 1):
        wid=work["id"]; path=cache/f"{wid}.json.gz"; url=f"{ROOTS}/{wid}.json.gz"; headers={}
        if path.exists(): data=path.read_bytes()
        elif offline: raise RuntimeError(f"missing required Azure v5 mapping: {wid}")
        else:
            req=urllib.request.Request(url, headers={"User-Agent":"Sutta-Study-Guide-TFIDF-Builder/1.0"})
            with urllib.request.urlopen(req, timeout=90) as response: data=response.read(); headers=dict(response.headers)
            path.write_bytes(data)
        obj=read_json_bytes(data)
        if obj.get("format") != V5_FORMAT or obj.get("root_work_id") != wid: raise RuntimeError(f"invalid v5 mapping: {wid}")
        payloads[wid]=obj; records.append({"work_id":wid,"url":url,"sha256":sha(data),"bytes":len(data),"etag":headers.get("ETag"),"last_modified":headers.get("Last-Modified"),"unit_count":len(obj.get("units",[]))})
        if index%10==0: print(f"v5 {index}/{len(works)}", file=sys.stderr)
    return payloads, records

def load_lexicon(z):
    lex=set(CORE); labels={x:x for x in CORE}; source=collections.Counter()
    proper=read_json_bytes(z.read(zip_member(z,"/terminology/proper-nouns.json")))
    user=read_json_bytes(z.read(zip_member(z,"/terminology/user-dictionary.json")))
    for item in proper:
        key=norm(item.get("pali_key") or item.get("pali") or "")
        if key and " " not in key and usable_term(key): lex.add(key); labels[key]=item.get("preferred_chinese") or item.get("english") or key; source["proper_nouns"]+=1
    for item in user:
        key=norm(item.get("dict_key") or "")
        if key and " " not in key and usable_term(key): lex.add(key); labels[key]=item.get("dict_content") or key; source["user_dictionary"]+=1
    # Dictionary shards are JSON despite the .gz object name in this export.
    for name in z.namelist():
        if "/dictionaries/" not in name or not name.endswith(".json.gz") or name.startswith("__MACOSX/"): continue
        try: entries=read_json_bytes(z.read(name))
        except Exception: continue
        if isinstance(entries,dict): entries=entries.get("entries") or entries.get("items") or entries.get("rows") or []
        dictionary=name.split("/dictionaries/",1)[1].split("/",1)[0]
        for item in entries:
            if not isinstance(item,dict): continue
            key=norm(item.get("dict_key") or item.get("key") or "")
            if key and " " not in key and TOKEN_RE.fullmatch(key) and len(key) < 48 and usable_term(key):
                lex.add(key); source[dictionary]+=1
    return lex,labels,{"accepted_unique":len(lex),"sources":dict(source)}

def intervals_from_v5(v5):
    refs=collections.defaultdict(list)
    for root_id,obj in v5.items():
        for unit in obj.get("units",[]):
            unit_ref={"root_work_id":root_id,"unit_id":unit.get("unit_id"),"root_start_row":unit.get("root_start_row"),"root_end_row":unit.get("root_end_row")}
            for field,level in (("commentaries","atthakatha"),("subcommentaries","tika")):
                for f in unit.get(field,[]):
                    a,b=f.get("start_row"),f.get("end_row"); wid=f.get("source_work_id")
                    if wid and isinstance(a,int) and isinstance(b,int) and a<=b:
                        refs[wid].append({"start":a,"end":b,"level":f.get("source_level") or level,"verification":f.get("verification"),**unit_ref})
    return refs

def canonical_segments(rows, work, refs, root_units):
    """Assign each row once. For overlaps choose shortest verified v5 interval.

    Contiguous rows with the same winning interval become one statistical document;
    every overlapping v5 unit is retained in provenance.
    """
    by_id={int(r.get("id",i)):r for i,r in enumerate(rows)}; ids=sorted(by_id)
    level=work.get("level") or "other"; assignments={}
    if level=="mula" and root_units:
        candidates=[{"start":u.get("root_start_row"),"end":u.get("root_end_row"),"unit_id":u.get("unit_id"),"root_work_id":work["id"],"level":"mula"} for u in root_units if isinstance(u.get("root_start_row"),int) and isinstance(u.get("root_end_row"),int)]
    else: candidates=refs
    for rid in ids:
        matches=[x for x in candidates if x["start"]<=rid<=x["end"]]
        if matches:
            matches.sort(key=lambda x:(x["end"]-x["start"],x["start"],str(x.get("unit_id"))))
            winner=matches[0]; key=(winner["start"],winner["end"],winner.get("unit_id"),winner.get("root_work_id"))
            provenance=sorted({(x.get("root_work_id"),x.get("unit_id")) for x in matches})
            assignments[rid]=(key,provenance,"v5_most_specific")
        else: assignments[rid]=(None,[],"unmapped")
    # For unmapped works/rows, headings create deterministic local documents.
    heading=0
    for rid in ids:
        row=by_id[rid]
        if row.get("rend") in HEAD_RENDS and plain(row.get("pali_text")): heading=rid
        if assignments[rid][0] is None: assignments[rid]=(("heading",heading),[],"heading_fallback")
    docs=[]; current=None
    for rid in ids:
        key,prov,method=assignments[rid]
        group=(key,tuple(prov),method)
        if current is None or current["_group"]!=group:
            current={"_group":group,"rows":[],"row_start":rid,"row_end":rid}; docs.append(current)
        current["rows"].append(by_id[rid]); current["row_end"]=rid
    for i,d in enumerate(docs):
        d["doc_id"]=f"{work['id']}:{d['row_start']}-{d['row_end']}"; d["work_id"]=work["id"]; d["parent_work_id"]=work["id"]; d["layer"]=level; d["title"]=work.get("title"); d["path"]=work.get("path") or []; d["segmentation_method"]=d["_group"][2]; d["v5_units"]=[{"root_work_id":x[0],"unit_id":x[1]} for x in d["_group"][1]]; del d["_group"]
    return docs

def tfidf_build(documents, lexicon, labels):
    dfs=collections.Counter(); counts={}; positions={}
    for doc in documents:
        c=collections.Counter(); pos=collections.defaultdict(list); sentence_ordinal=0
        for row in doc.pop("rows"):
            rid=int(row.get("id",0)); segments=[x for x in SENTENCE_RE.split(plain(row.get("pali_text"))) if x.strip()] or [""]
            for segment in segments:
                tokens=[norm(x) for x in TOKEN_RE.findall(segment)]
                for offset,t in enumerate(tokens):
                    if t in lexicon: c[t]+=1; pos[t].append([rid,sentence_ordinal,offset])
                sentence_ordinal+=1
        counts[doc["doc_id"]]=c; positions[doc["doc_id"]]=pos; dfs.update(c.keys()); doc["token_count"]=sum(c.values()); doc["concept_count"]=len(c)
    n=len(documents); postings=collections.defaultdict(list); concept_meta={}
    for doc in documents:
        did=doc["doc_id"]; raw={t:(1+math.log(f))*(math.log((n+1)/(dfs[t]+1))+1) for t,f in counts[did].items()}; length=math.sqrt(sum(v*v for v in raw.values())) or 1
        for t,score in raw.items(): postings[t].append({"doc_id":did,"tf":counts[did][t],"tfidf":round(score/length,8),"positions":positions[did][t]})
    concepts=[]; admitted=set(); doc_work={d["doc_id"]:d["parent_work_id"] for d in documents}
    for term,items in postings.items():
        work_count=len({doc_work[x["doc_id"]] for x in items})
        scores=sorted((x["tfidf"] for x in items),reverse=True); threshold=scores[max(0,math.ceil(len(scores)*.05)-1)] if scores else 0
        top_docs=sum(x["tfidf"]>=threshold for x in items)
        is_core=term in CORE; ok=is_core or (len(items)>=3 and work_count>=2 and top_docs>=3)
        if ok:
            admitted.add(term); concepts.append({"concept_id":term,"pali":term,"label":labels.get(term,term),"document_frequency":len(items),"parent_work_count":work_count,"max_tfidf":max(scores),"mean_tfidf":round(statistics.fmean(scores),8),"core_term":is_core,"admission":"core" if is_core else "dictionary_statistics_audit","ai_audit_status":"pending"})
    concepts.sort(key=lambda x:(-x["max_tfidf"],-x["document_frequency"],x["pali"]))
    return concepts,{t:postings[t] for t in admitted},counts,n

def relation_build(documents, concepts, postings, counts, n):
    try:
        import numpy as np
        from scipy.sparse import csr_matrix
    except ImportError as exc: raise RuntimeError("relation build requires numpy and scipy") from exc
    terms=sorted(postings); term_index={t:i for i,t in enumerate(terms)}; doc_index={d["doc_id"]:i for i,d in enumerate(documents)}; doc_work={d["doc_id"]:d["parent_work_id"] for d in documents}
    rr=[]; cc=[]; vv=[]; docsets={}; by_doc=collections.defaultdict(list); position_map={}
    for term,items in postings.items():
        ds=set()
        for item in items:
            di=doc_index[item["doc_id"]]; rr.append(term_index[term]); cc.append(di); vv.append(item["tfidf"]); ds.add(di); by_doc[di].append((term,item["positions"])); position_map[(term,di)]=sorted({p[1] for p in item["positions"]})
        docsets[term]=ds
    matrix=csr_matrix((np.asarray(vv,dtype=np.float32),(rr,cc)),shape=(len(terms),len(documents)))
    concept_norms=np.sqrt(np.asarray(matrix.multiply(matrix).sum(axis=1)).ravel()); concept_norms[concept_norms==0]=1
    cosine_matrix=matrix.multiply((1/concept_norms)[:,None]).tocsr()
    # Build a sparse term × (document,row-window) matrix. Multiplication gives a
    # complete candidate superset in C; exact distinct-document counts follow.
    feature_index={}; lr=[]; lc=[]
    for di,items in by_doc.items():
        for term,positions in items:
            ti=term_index[term]
            for _,sentence,_ in positions:
                for delta in range(-2,3):
                    feature=(di,sentence+delta); fi=feature_index.setdefault(feature,len(feature_index)); lr.append(ti); lc.append(fi)
    local_matrix=csr_matrix((np.ones(len(lr),dtype=np.uint8),(lr,lc)),shape=(len(terms),len(feature_index))); local_matrix.data[:]=1; local_matrix.eliminate_zeros()
    # Sparse block multiplication finds every cosine >= .20 without a top-K cut.
    df={x["concept_id"]:x["document_frequency"] for x in concepts}; relations=[]; seen_types=set()
    block=256; doc_work_by_index=[d["parent_work_id"] for d in documents]; doc_layer_by_index=[d["layer"] for d in documents]
    for start in range(0,len(terms),block):
        product_csr=(cosine_matrix[start:start+block] @ cosine_matrix.T).tocsr(); product=product_csr.tocoo()
        cosine_candidates={}
        for i,j,value in zip(product.row,product.col,product.data):
            gi=start+int(i)
            if gi<int(j) and float(value)>=.20: cosine_candidates[(terms[gi],terms[int(j)])]=float(value)
        local_product=(local_matrix[start:start+block].astype(np.uint32) @ local_matrix.T.astype(np.uint32)).tocoo()
        local_candidates={}
        for i,j,value in zip(local_product.row,local_product.col,local_product.data):
            gi=start+int(i)
            if gi<int(j) and int(value)>=3 and float(product_csr[int(i),int(j)])>=.05: local_candidates[(terms[gi],terms[int(j)])]=int(value)
        for a,b in sorted(set(cosine_candidates)|set(local_candidates)):
            shared=docsets[a]&docsets[b]; joint=len(shared)
            if joint<3: continue
            pxy=joint/n; npmi=math.log(pxy/((df[a]/n)*(df[b]/n)))/(-math.log(pxy)) if 0<pxy<1 else 0
            # A local edge is still a cross-document discovery relation. Requiring
            # positive normalized mutual information removes generic words that
            # happen to share many long passages without a specific association.
            if npmi<.10: continue
            work_ids=set(); layer_counts=collections.Counter()
            for di in shared:
                work_ids.add(doc_work_by_index[di]); layer_counts[doc_layer_by_index[di]]+=1
            work_count=len(work_ids)
            if work_count<2: continue
            local_count=local_candidates.get((a,b),0)
            cosine=cosine_candidates[(a,b)] if (a,b) in cosine_candidates else float(product_csr[term_index[a]-start,term_index[b]])
            types=[]
            if cosine>=.20 and npmi>=.10: types.append("cross_document_salience")
            if local_count>=3: types.append("local_context_cooccurrence")
            for typ in types:
                unique=(typ,a,b)
                if unique in seen_types: continue
                seen_types.add(unique); relations.append({"relation_id":f"{typ}:{a}:{b}","source":a,"target":b,"relation_type":typ,"direction":"undirected","document_count":joint,"parent_work_count":work_count,"layer_document_counts":dict(layer_counts),"local_context_window_count":local_count,"cosine":round(cosine,8),"npmi":round(npmi,8),"semantic_claim":"statistical_association_only","evidence_locator":{"source_postings":f"postings/{a[:2]}.json.gz#{a}","target_postings":f"postings/{b[:2]}.json.gz#{b}","join":"doc_id","positions":"[row_id,sentence_ordinal,token_offset]"},"ai_audit_status":"pending"})
        if start%(block*20)==0: print(f"relations {start}/{len(terms)}",file=sys.stderr)
    relations.sort(key=lambda x:(-x["cosine"],-x["npmi"],x["relation_id"])); return relations

def ai_audit(out, concepts, relations, args):
    endpoint=args.ai_endpoint or os.getenv("CONCEPT_AUDIT_ENDPOINT"); key=args.ai_key or os.getenv("CONCEPT_AUDIT_API_KEY"); model=args.ai_model
    candidates=([{"kind":"concept",**x} for x in concepts[:200]] + [{"kind":"relation",**x} for x in relations[:200]])
    if not endpoint or not key:
        if args.release: raise RuntimeError("release requires AI audit endpoint and key")
        return {"status":"not_run","reason":"missing_api_configuration","candidate_count":len(candidates)}
    endpoint=endpoint.rstrip("/"); endpoint=endpoint if endpoint.endswith("/chat/completions") else endpoint+"/chat/completions"
    def audit_batch(batch):
        prompt={"task":"Audit Pali TF-IDF discovery candidates. A concept is verified when it is an attested Pali dictionary or corpus word-form; it need not be a doctrinal concept and inflected forms are allowed. A relation is verified when both endpoints are accepted word-forms and the supplied TF-IDF/NPMI/co-occurrence fields describe a real statistical association. Do not reject a relation merely because it is formulaic, grammatical, narrative, or not causal: this layer intentionally records such statistical associations. Reject only stopwords/structural headings, obvious sandhi fragments, impossible statistics (for example cosine outside 0..1), or unsupported/ambiguous endpoints. Never reinterpret this as doctrinal causality. Return strict JSON object with items [{id,verdict:verified|rejected|ambiguous,reason}].", "items":[{"id":x.get("concept_id") or x.get("relation_id"),**x} for x in batch]}
        body={"model":model,"temperature":0,"messages":[{"role":"system","content":"You are a conservative Pali corpus quality auditor. Output JSON only."},{"role":"user","content":json.dumps(prompt,ensure_ascii=False)}],"response_format":{"type":"json_object"},"thinking":{"type":"enabled","budget_tokens":4096}}
        req=urllib.request.Request(endpoint,data=json.dumps(body).encode(),headers={"Authorization":f"Bearer {key}","Content-Type":"application/json"},method="POST")
        with urllib.request.urlopen(req,timeout=120) as response: raw=response.read()
        result=json.loads(raw); content=result["choices"][0]["message"]["content"]; parsed=json.loads(content); return parsed if isinstance(parsed,list) else parsed.get("items",[])
    batches=[candidates[start:start+20] for start in range(0,len(candidates),20)]; verdicts=[]
    with ThreadPoolExecutor(max_workers=min(8,len(batches))) as pool:
        futures=[pool.submit(audit_batch,batch) for batch in batches]
        for future in as_completed(futures): verdicts.extend(future.result())
    returned_ids={x.get("id") for x in verdicts if x.get("id")}; missing=[x for x in candidates if (x.get("concept_id") or x.get("relation_id")) not in returned_ids]
    if missing:
        # Models occasionally omit one item in a large JSON response. Retry only
        # the missing candidates, independently, so the gate never treats an
        # incomplete response as a successful audit.
        with ThreadPoolExecutor(max_workers=min(4,len(missing))) as pool:
            futures=[pool.submit(audit_batch,[item]) for item in missing]
            for future in as_completed(futures): verdicts.extend(future.result())
    verdict={x["id"]:x for x in verdicts if x.get("id")};
    for item in concepts: item["ai_audit_status"]=verdict.get(item["concept_id"],{}).get("verdict","not_sampled")
    for item in relations: item["ai_audit_status"]=verdict.get(item["relation_id"],{}).get("verdict","not_sampled")
    checked=[x for x in verdicts if x.get("verdict") in {"verified","rejected","ambiguous"}]; verified=sum(x.get("verdict")=="verified" for x in checked); rejected=sum(x.get("verdict")=="rejected" for x in checked)
    ambiguous=sum(x.get("verdict")=="ambiguous" for x in checked); report={"status":"passed" if len(checked)==len(candidates) and verified/len(checked)>=.85 and rejected/len(checked)<=.15 and ambiguous/len(checked)<=.05 else "failed","gate":{"verified_min":.85,"rejected_max":.15,"ambiguous_max":.05},"model":model,"thinking_strength":"max","temperature":0,"candidate_count":len(candidates),"checked_count":len(checked),"verified":verified,"rejected":rejected,"ambiguous":ambiguous,"verdicts":verdicts}
    if args.release and report["status"]!="passed": raise RuntimeError("AI audit gate failed: " + json.dumps({k:report[k] for k in ("gate","candidate_count","checked_count","verified","rejected","ambiguous")},ensure_ascii=False))
    return report

def main():
    p=argparse.ArgumentParser(); p.add_argument("--archive",required=True); p.add_argument("--output",required=True); p.add_argument("--v5-cache",default=".cache/commentary-links-v5/roots"); p.add_argument("--offline",action="store_true"); p.add_argument("--release",action="store_true"); p.add_argument("--audit-existing",action="store_true"); p.add_argument("--ai-endpoint"); p.add_argument("--ai-key"); p.add_argument("--ai-model",default="deepseek-v4-flash"); args=p.parse_args()
    out=pathlib.Path(args.output); out.mkdir(parents=True,exist_ok=True)
    archive=pathlib.Path(args.archive); archive_hash=sha(archive.read_bytes())
    if args.audit_existing:
        concepts=read_json_bytes((out/"concepts.json.gz").read_bytes())
        relations=[]; relation_paths=[]
        for path in sorted((out/"relations").glob("*.json.gz")):
            rows=read_json_bytes(path.read_bytes()); relation_paths.append((path,rows)); relations.extend(rows)
        manifest=read_json_bytes((out/"manifest.json").read_bytes()); unique={x["relation_id"]:x for x in relations}; audit=ai_audit(out,concepts,list(unique.values()),args)
        status={x["relation_id"]:x.get("ai_audit_status") for x in unique.values()}
        for path,rows in relation_paths:
            for row in rows: row["ai_audit_status"]=status.get(row["relation_id"],row.get("ai_audit_status","not_sampled"))
            meta=write_json(path,rows,True); name=path.name
            for item in manifest.get("relation_shards",[]):
                if item.get("path")==name: item.update({"bytes":meta["bytes"],"sha256":meta["sha256"]})
        concept_meta=write_json(out/"concepts.json.gz",concepts,True)
        audit_meta=write_json(out/"audit"/"ai-quality-audit.json",audit)
        manifest["quality_gate"]=audit["status"]; manifest["generated_at"]=dt.datetime.now(dt.timezone.utc).isoformat()
        for item in manifest.get("files",[]):
            if item.get("path")=="concepts.json.gz": item.update({"bytes":concept_meta["bytes"],"sha256":concept_meta["sha256"]})
            if item.get("path")=="audit/ai-quality-audit.json": item.update({"bytes":audit_meta["bytes"],"sha256":audit_meta["sha256"]})
        write_json(out/"manifest.json",manifest)
        print(json.dumps({"mode":"audit_existing","concepts":len(concepts),"relations":len(unique),"audit":audit},ensure_ascii=False)); return
    with zipfile.ZipFile(archive) as z:
        works=read_json_bytes(z.read(zip_member(z,"/catalog/works.json"))); root_works=[w for w in works if w.get("level")=="mula"]
        v5,v5_sources=fetch_v5(root_works,pathlib.Path(args.v5_cache),args.offline); lexicon,labels,lex_audit=load_lexicon(z); refs=intervals_from_v5(v5)
        documents=[]
        for i,work in enumerate(works,1):
            rows=read_json_bytes(z.read(zip_member(z,"/"+work["data_file"]))).get("rows",[])
            documents.extend(canonical_segments(rows,work,refs.get(work["id"],[]),v5.get(work["id"],{}).get("units",[])))
            if i%20==0: print(f"corpus {i}/{len(works)}",file=sys.stderr)
    concepts,postings,counts,n=tfidf_build(documents,lexicon,labels); relations=relation_build(documents,concepts,postings,counts,n); audit=ai_audit(out,concepts,relations,args)
    files=[]; files.append(write_json(out/"documents.json.gz",documents,True)); files.append(write_json(out/"concepts.json.gz",concepts,True))
    relation_shards=[]; relation_groups=collections.defaultdict(list)
    for item in relations:
        prefixes={item["source"][:2],item["target"][:2]}
        for prefix in prefixes: relation_groups[prefix].append(item)
    for prefix,payload in sorted(relation_groups.items()):
        meta=write_json(out/"relations"/f"{prefix}.json.gz",payload,True); meta.update({"prefix":prefix,"relation_count":len(payload),"endpoint_indexed":True}); relation_shards.append(meta)
    shard_meta=[]
    for prefix in sorted({t[:2] for t in postings}):
        payload={t:postings[t] for t in sorted(postings) if t.startswith(prefix)}; meta=write_json(out/"postings"/f"{prefix}.json.gz",payload,True); meta["prefix"]=prefix; shard_meta.append(meta)
    for name,payload in (("ai-quality-audit.json",audit),("commentary-links-v5-source.json",{"format":V5_FORMAT,"files":v5_sources}),("lexicon.json",lex_audit)):
        meta=write_json(out/"audit"/name,payload); meta["path"]="audit/"+name; files.append(meta)
    manifest={"format":OUT_FORMAT,"generated_at":dt.datetime.now(dt.timezone.utc).isoformat(),"source":{"archive":str(archive),"archive_sha256":archive_hash,"commentary_links":V5_FORMAT,"v5_object_count":len(v5_sources)},"tfidf":{"tf":"1+ln(freq)","idf":"ln((N+1)/(df+1))+1","normalization":"L2"},"counts":{"works":len(works),"documents":len(documents),"concepts":len(concepts),"relations":len(relations),"postings_shards":len(shard_meta),"relation_shards":len(relation_shards)},"segmentation":{"overlap_resolution":"shortest verified v5 interval wins; all matches retained as provenance","fallback":"heading boundaries for rows without v5 mapping"},"quality_gate":audit["status"],"files":files,"postings":shard_meta,"relation_shards":relation_shards}
    write_json(out/"manifest.json",manifest); print(json.dumps(manifest["counts"],ensure_ascii=False))

if __name__=="__main__": main()
