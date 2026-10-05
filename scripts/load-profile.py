#!/usr/bin/env python3
"""Measure a disposable Docker stack; no production URL/DB/volume option exists."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
import datetime as dt
import hashlib
import http.cookiejar
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

PG_IMAGE = 'postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24'


def run(argv, timeout=120, **kwargs):
    result = subprocess.run(argv, timeout=timeout, stderr=subprocess.DEVNULL, **kwargs)
    if result.returncode:
        raise RuntimeError('Isolated command failed: ' + argv[0])
    return result


def percentile(values, fraction):
    ordered = sorted(value for value in values if value is not None)
    return round(ordered[max(0, math.ceil(len(ordered)*fraction)-1)], 4) if ordered else None


class Client:
    def __init__(self, origin):
        self.origin = origin
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, data=None, headers=None):
        request = urllib.request.Request(self.origin+path, data=data, headers={'Origin': self.origin} | (headers or {}))
        try:
            with self.opener.open(request, timeout=30) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as response:
            return response.code, response.read()

    def json(self, path, value=None):
        code, body = self.request(path, json.dumps(value).encode() if value is not None else None, {'Content-Type': 'application/json'})
        return code, json.loads(body)


def cgroup_for(container):
    pid = int(run(['docker','inspect',container,'--format','{{.State.Pid}}'], stdout=subprocess.PIPE).stdout)
    for line in Path(f'/proc/{pid}/cgroup').read_text().splitlines():
        if line.startswith('0::'):
            return Path('/sys/fs/cgroup') / line[3:].lstrip('/')
    raise RuntimeError('cgroup v2 is required')


def metrics(path):
    cpu = dict(line.split() for line in (path/'cpu.stat').read_text().splitlines())
    io_read, io_write, rss, ffmpeg_rss = 0, 0, 0, 0
    for line in (path/'io.stat').read_text().splitlines():
        values = dict(part.split('=',1) for part in line.split()[1:])
        io_read += int(values.get('rbytes',0))
        io_write += int(values.get('wbytes',0))
    for pid in (path/'cgroup.procs').read_text().split():
        try:
            stat = Path(f'/proc/{pid}/stat').read_text()
            name = stat[stat.find('(')+1:stat.rfind(')')]
            size = int(stat[stat.rfind(')')+2:].split()[21])*os.sysconf('SC_PAGE_SIZE')
            rss += size
            if name in ('ffmpeg','ffprobe'):
                ffmpeg_rss += size
        except (OSError, ValueError):
            pass
    return {'cpu_seconds':int(cpu['usage_usec'])/1e6, 'throttled_seconds':int(cpu.get('throttled_usec',0))/1e6, 'memory_peak_bytes':int((path/'memory.peak').read_text()), 'memory_current_bytes':int((path/'memory.current').read_text()), 'memory_max_bytes':int((path/'memory.max').read_text()), 'cpu_max':(path/'cpu.max').read_text().strip(), 'read_bytes':io_read, 'write_bytes':io_write, 'rss_sum_bytes':rss, 'ffmpeg_rss_bytes':ffmpeg_rss}


def remove_owned(identifier, containers, network_created, output):
    """A log failure must not skip other removals; never remove a foreign name."""
    cleaned, errors = [], []
    for container in reversed(containers):
        try:
            inspected = subprocess.run(['docker','inspect',container,'--format','{{index .Config.Labels "cutmy.load-owner"}}'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10)
            if inspected.returncode:
                errors.append('ownership inspection failed: '+container)
                continue
            if inspected.stdout.decode().strip() != identifier:
                errors.append('ownership mismatch: '+container)
                continue
            try:
                with (output/(container.rsplit('-',1)[-1]+'.log')).open('wb') as log:
                    subprocess.run(['docker','logs',container],stdout=log,stderr=subprocess.STDOUT,timeout=15)
            except (OSError, subprocess.TimeoutExpired):
                pass
            if subprocess.run(['docker','rm','-f','-v',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30).returncode==0:
                cleaned.append(container)
            else:
                errors.append('removal failed: '+container)
        except (OSError, subprocess.TimeoutExpired):
            errors.append('cleanup command failed: '+container)
    network_removed=not network_created
    if network_created:
        try:
            inspected=subprocess.run(['docker','network','inspect',identifier,'--format','{{index .Labels "cutmy.load-owner"}}'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10)
            if inspected.returncode:
                errors.append('network ownership inspection failed')
            elif inspected.stdout.decode().strip()==identifier:
                network_removed=subprocess.run(['docker','network','rm',identifier],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30).returncode==0
        except (OSError, subprocess.TimeoutExpired):
            errors.append('network cleanup command failed')
    (output/'cleanup.json').write_text(json.dumps({'owned_containers_removed':cleaned,'cleanup_complete':len(cleaned)==len(containers) and network_removed,'errors':errors,'production_resources_touched':False})+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--core-commit', required=True, help='Exact 40-character core revision compiled into the image')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--users', type=int, default=4)
    parser.add_argument('--worker-concurrency', type=int, choices=(1,2,3), default=1)
    parser.add_argument('--duration', type=int, default=30)
    parser.add_argument('--export-duration', type=int, default=6)
    parser.add_argument('--fps', type=int, choices=(25,30,60), default=30)
    parser.add_argument('--size', choices=('640x360','1280x720','1920x1080'), default='1920x1080')
    parser.add_argument('--timeout', type=int, default=600)
    parser.add_argument('--burst-admission', action='store_true', help='Hold worker until all submissions; 12 users => 36 jobs')
    parser.add_argument('--cgroup-limits', action='store_true', help='Compatibility flag; Docker limits are always applied')
    parser.add_argument('--hls-test-binary', type=Path, help='Optional prebuilt Linux Go test binary for HLS CPU/heap profiles')
    args = parser.parse_args()
    if os.getuid()!=0 or not Path('/sys/fs/cgroup/cgroup.controllers').exists():
        parser.error('Root and Linux cgroup v2 required')
    if not 1<=args.users<=64 or not 10<=args.duration<=600 or not 1<=args.export_duration<=args.duration-3 or not 30<=args.timeout<=3600:
        parser.error('Invalid workload bounds')
    if not re.fullmatch('[0-9a-f]{40}',args.core_commit):
        parser.error('Invalid core commit')
    os.umask(0o077)
    args.output.mkdir(parents=True, exist_ok=False, mode=0o700)
    args.output=args.output.resolve()
    identifier='cutmy-load-'+uuid.uuid4().hex[:12]
    postgres=identifier+'-pg'
    containers=[]
    groups={}
    network_created=False
    samples=[]
    jobs=[]
    rejections=[]
    lock=threading.Lock()
    stop=threading.Event()
    admission_done=threading.Event()
    admission_count=0
    upload_slots=threading.Semaphore(4)
    sampler=None
    began=time.monotonic()
    try:
        image_id=run(['docker','image','inspect',args.image,'--format','{{.Id}}'],stdout=subprocess.PIPE).stdout.decode().strip()
        with tempfile.TemporaryDirectory(prefix=identifier+'-') as temporary:
            directory=Path(temporary)
            data=directory/'data'
            data.mkdir(mode=0o777)
            data.chmod(0o777)  # Only this private disposable bind mount is shared.
            fixture=directory/'fixture'
            fixture.mkdir()
            artifacts=directory/'artifacts'
            artifacts.mkdir()
            fixture_container=identifier+'-fixture'
            containers.append(fixture_container)
            run(['docker','run','--name',fixture_container,'--label','cutmy.load-owner='+identifier,'--network','none','--user','0:0','--memory','1g','--cpus','2','-v',str(fixture)+':/fixture','--entrypoint','ffmpeg',args.image,'-v','error','-f','lavfi','-i',f'testsrc2=size={args.size}:rate={args.fps}','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',str(args.duration),'-c:v','libx264','-threads','2','-preset','fast','-g',str(2*args.fps),'-c:a','aac','-movflags','+faststart','/fixture/source.mp4'], timeout=240, stdout=subprocess.DEVNULL)
            source_bytes=(fixture/'source.mp4').read_bytes()
            run(['docker','network','create','--label','cutmy.load-owner='+identifier,identifier],stdout=subprocess.DEVNULL)
            network_created=True
            containers.append(postgres)
            run(['docker','run','-d','--name',postgres,'--label','cutmy.load-owner='+identifier,'--network',identifier,'--memory','512m','--cpus','1','--pids-limit','128','-e','POSTGRES_PASSWORD=isolated-load-fixture','-e','POSTGRES_USER=cutmy','-e','POSTGRES_DB=cutmy',PG_IMAGE],stdout=subprocess.DEVNULL)
            for _ in range(100):
                if subprocess.run(['docker','exec',postgres,'pg_isready','-h','127.0.0.1','-U','cutmy','-d','cutmy'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5).returncode==0:
                    break
                time.sleep(.2)
            else:
                raise RuntimeError('Owned PostgreSQL not ready')
            with socket.socket() as probe:
                probe.bind(('127.0.0.1',0))
                api_port=probe.getsockname()[1]
            origin=f'http://127.0.0.1:{api_port}'
            environment={'DATABASE_URL':f'postgres://cutmy:isolated-load-fixture@{postgres}:5432/cutmy?sslmode=disable','DATA_DIR':'/data','LISTEN_ADDR':':8080','PUBLIC_ORIGIN':origin,'COOKIE_SECURE':'false','TRUST_PROXY':'false','MAX_STORAGE_BYTES':str(2*1024**3),'MAX_SOURCE_BYTES':str(64*1024**2),'MAX_OUTPUT_BYTES':str(32*1024**2),'MAX_OWNER_BYTES':str(256*1024**2),'STORAGE_SAFETY_BYTES':str(512*1024**2),'MUTATIONS_PER_MINUTE':'10000','SOURCE_TTL':'24h','ARTIFACT_TTL':'24h','FFMPEG_THREADS':'2','WORKER_CONCURRENCY':str(args.worker_concurrency),'GOMEMLIMIT':'128MiB'}
            def launch(role):
                name=identifier+'-'+role
                argv=['docker','run','-d','--name',name,'--label','cutmy.load-owner='+identifier,'--network',identifier,'--memory','512m' if role=='server' else '4g','--cpus','1' if role=='server' else '3','--pids-limit','256','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/tmp:size=128m,noexec,nosuid,nodev','-v',str(data)+':/data']
                if role=='server':
                    argv+=['-p',f'127.0.0.1:{api_port}:8080']
                for key,value in environment.items():
                    argv+=['-e',key+'='+value]
                containers.append(name)
                run(argv+[args.image,role],stdout=subprocess.DEVNULL)
                groups[role]=cgroup_for(name)
            launch('server')
            for _ in range(100):
                try:
                    if Client(origin).request('/readyz')[0]==200:
                        break
                except OSError:
                    pass
                time.sleep(.1)
            else:
                raise RuntimeError('Owned API not ready')
            # Fixture-only event timestamps eliminate polling bias. Production
            # code/schema is untouched; three small INSERTs per job add overhead.
            sql="""CREATE TABLE load_job_events(job_id text,status text,at timestamptz);
CREATE FUNCTION load_record_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
IF TG_OP='INSERT' OR OLD.status IS DISTINCT FROM NEW.status THEN
 INSERT INTO load_job_events VALUES(NEW.id,NEW.status,clock_timestamp()); END IF;
RETURN NULL; END $$;
CREATE TRIGGER load_job_event AFTER INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION load_record_job();"""
            run(['docker','exec','-i',postgres,'psql','-U','cutmy','-d','cutmy','-v','ON_ERROR_STOP=1','-q'],input=sql.encode(),stdout=subprocess.DEVNULL)
            if not args.burst_admission:
                launch('worker')
            baseline={role:metrics(path) for role,path in groups.items()}
            def sample():
                while not stop.wait(.1):
                    row={'elapsed_seconds':round(time.monotonic()-began,3)}
                    for role,path in list(groups.items()):
                        try:
                            value=metrics(path)
                            for field in ('rss_sum_bytes','ffmpeg_rss_bytes','memory_current_bytes','cpu_seconds'):
                                row[role+'_'+field]=value[field]
                        except OSError:
                            pass
                    with lock:
                        row['queued_observed']=sum(entry.get('observed_status') in ('queued','waiting_storage') for entry in jobs)
                        samples.append(row)
            sampler=threading.Thread(target=sample,daemon=True)
            sampler.start()
            boundary='cutmy-isolated-'+uuid.uuid4().hex
            upload=('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="fixture.mp4"\r\nContent-Type: video/mp4\r\n\r\n').encode()+source_bytes+('\r\n--'+boundary+'--\r\n').encode()
            workload_started=time.monotonic()
            def finish_admission():
                nonlocal admission_count
                with lock:
                    admission_count+=1
                    last=admission_count==args.users
                if last and args.burst_admission:
                    launch('worker')
                    baseline['worker']=metrics(groups['worker'])
                    admission_done.set()
            def user(index):
                client=Client(origin)
                client.request('/api/v1/session')
                accepted=[]
                try:
                    with upload_slots:
                        uploaded_at=time.monotonic()
                        code,raw=client.request('/api/v1/uploads',upload,{'Content-Type':'multipart/form-data; boundary='+boundary})
                    source=json.loads(raw)
                    if code!=201:
                        with lock:
                            rejections.append({'session':index,'stage':'upload','http_status':code,'error_code':source.get('error',{}).get('code')})
                        return
                    preparation=time.monotonic()-uploaded_at
                    for scenario,format_name,mode in (('copy','mp4','copy'),('accurate','mp4','accurate'),('mp3','mp3','accurate')):
                        submitted=time.monotonic()
                        quality = '1080p' if scenario == 'accurate' else 'best'
                        code,job=client.json('/api/v1/jobs',{'source_id':source['id'],'ranges':[{'start_ms':2250,'end_ms':2250+args.export_duration*1000,'label':scenario}],'format':format_name,'quality':quality,'cut_mode':mode})
                        if code!=202:
                            with lock:
                                rejections.append({'session':index,'stage':scenario,'http_status':code,'error_code':job.get('error',{}).get('code')})
                            continue
                        entry={'session':index,'scenario':scenario,'id':job['id'],'submitted':submitted,'observed_status':job['status'],'source_seconds':round(preparation,4)}
                        with lock:
                            jobs.append(entry)
                        accepted.append(entry)
                finally:
                    finish_admission()
                if args.burst_admission and not admission_done.wait(args.timeout):
                    raise RuntimeError('Burst admission incomplete')
                while accepted:
                    if time.monotonic()-workload_started>args.timeout:
                        raise RuntimeError('Isolated suite exceeded deadline')
                    for entry in list(accepted):
                        code,job=client.json('/api/v1/jobs/'+entry['id'])
                        if code!=200:
                            raise RuntimeError('Owned job polling failed')
                        with lock:
                            entry['observed_status']=job['status']
                        if job['status'] in ('succeeded','failed','cancelled'):
                            bytes_out,durations=0,[]
                            for item in job['items']:
                                artifact=item.get('artifact')
                                if artifact:
                                    code,payload=client.request(artifact['download_url'])
                                    if code!=200 or len(payload)!=artifact['size_bytes']:
                                        raise RuntimeError('Artifact download size check failed')
                                    duration=artifact['actual_end_ms']-artifact['actual_start_ms']
                                    if entry['scenario']!='copy' and abs(duration-args.export_duration*1000)>350:
                                        raise RuntimeError('Accurate artifact duration invalid')
                                    durations.append(duration)
                                    bytes_out+=len(payload)
                                    (artifacts/(entry['id']+'-'+str(len(durations))+('.mp3' if entry['scenario']=='mp3' else '.mp4'))).write_bytes(payload)
                            with lock:
                                entry.update({'completed':time.monotonic(),'status':job['status'],'output_bytes':bytes_out,'checked_durations_ms':durations,'error_codes':[item.get('error_code') for item in job['items'] if item.get('error_code')]})
                            accepted.remove(entry)
                    time.sleep(1.25)  # Real 180/min owner cap remains enabled.
            with ThreadPoolExecutor(max_workers=args.users) as pool:
                list(pool.map(user,range(args.users)))
            workload_seconds=time.monotonic()-workload_started
            stop.set()
            sampler.join(timeout=5)
            query="SELECT coalesce(json_agg(x),'[]') FROM (SELECT job_id,extract(epoch FROM min(at) FILTER(WHERE status='running')-min(at)) AS queue_seconds,extract(epoch FROM min(at) FILTER(WHERE status IN ('succeeded','failed','cancelled'))-min(at)) AS total_seconds FROM load_job_events GROUP BY job_id) x;"
            timing=json.loads(run(['docker','exec',postgres,'psql','-U','cutmy','-d','cutmy','-At','-c',query],stdout=subprocess.PIPE).stdout)
            by_id={row['job_id']:row for row in timing}
            safe_jobs=[]
            for entry in jobs:
                row={key:value for key,value in entry.items() if key not in ('submitted','completed')}
                row.update({'queue_wait_seconds':by_id[entry['id']]['queue_seconds'],'server_total_seconds':by_id[entry['id']]['total_seconds'],'download_complete_seconds':round(entry['completed']-entry['submitted'],4)})
                safe_jobs.append(row)
            group_results={}
            for role,path in groups.items():
                value=metrics(path)
                for field in ('cpu_seconds','throttled_seconds','read_bytes','write_bytes'):
                    value[field]=round(value[field]-baseline.get(role,{}).get(field,0),6)
                group_results[role]=value
            verifier=identifier+'-verify'
            containers.append(verifier)
            verify_code="import hashlib,json,pathlib,subprocess; print(json.dumps({'durations':{p.name:float(json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','json',str(p)],timeout=15))['format']['duration'])*1000 for p in pathlib.Path('/artifacts').iterdir()},'cutmy_binary_sha256':hashlib.sha256(pathlib.Path('/usr/local/bin/cutmy').read_bytes()).hexdigest(),'ffmpeg_version':subprocess.check_output(['ffmpeg','-version'],timeout=15).decode().splitlines()[0]}))"
            verification=json.loads(run(['docker','run','--name',verifier,'--label','cutmy.load-owner='+identifier,'--network','none','--user','0:0','--cpus','1','--memory','512m','--read-only','--cap-drop','ALL','-v',str(artifacts)+':/artifacts:ro','--entrypoint','python3',args.image,'-c',verify_code],timeout=180,stdout=subprocess.PIPE).stdout)
            probed=verification['durations']
            for row in safe_jobs:
                actual=[round(duration,3) for name,duration in probed.items() if name.startswith(row['id']+'-')]
                if len(actual)!=len(row['checked_durations_ms']) or (row['scenario']!='copy' and any(abs(duration-args.export_duration*1000)>350 for duration in actual)):
                    raise RuntimeError('Independent download duration validation failed')
                row['ffprobe_download_durations_ms']=actual
            report={'measured_at':dt.datetime.now(dt.timezone.utc).isoformat(),'scope':'isolated Docker API + worker pool + disposable PG17; synthetic H264/AAC upload, copy, accurate MP4, MP3','production':False,'cpu_count_host':os.cpu_count(),'image':args.image,'image_id':image_id,'core_commit':args.core_commit,'cutmy_binary_sha256':verification['cutmy_binary_sha256'],'ffmpeg_version':verification['ffmpeg_version'],'worker_concurrency':args.worker_concurrency,'ffmpeg_threads':2,'users':args.users,'burst_admission':args.burst_admission,'source_size':args.size,'source_fps':args.fps,'source_duration_seconds':args.duration,'export_duration_seconds':args.export_duration,'source_bytes_each':len(source_bytes),'fixture_sha256':hashlib.sha256(source_bytes).hexdigest(),'workload_seconds':round(workload_seconds,4),'jobs_accepted':len(jobs),'jobs_succeeded':sum(entry['status']=='succeeded' for entry in jobs),'jobs_failed':sum(entry['status']=='failed' for entry in jobs),'rejections':rejections,'throughput_jobs_per_minute':round(60*len(jobs)/workload_seconds,3),'queue_wait_seconds':{'p50':percentile([row['queue_wait_seconds'] for row in safe_jobs],.5),'p95':percentile([row['queue_wait_seconds'] for row in safe_jobs],.95)},'server_total_seconds':{'p50':percentile([row['server_total_seconds'] for row in safe_jobs],.5),'p95':percentile([row['server_total_seconds'] for row in safe_jobs],.95)},'cgroups':group_results,'output_bytes':sum(entry['output_bytes'] for entry in jobs),'upload_bytes_total':len(source_bytes)*(args.users-sum(row['stage']=='upload' for row in rejections)),'jobs':safe_jobs,'limitations':['Fixture-only transition trigger adds three small DB INSERTs per job','Cgroup memory.peak includes file cache; 100ms RSS samples may double count shared pages','HTTP completion polling is 1.25s; server queue/total stamps exclude polling/download','DB, fixture generation, independent artifact verification and controller resources excluded from API/worker cgroups','Synthetic clips and this small suite do not establish production user-count capacity']}
            if args.hls_test_binary:
                hls=identifier+'-hls'
                containers.append(hls)
                evidence=directory/'hls-output'
                evidence.mkdir(mode=0o777)
                evidence.chmod(0o777)
                started=time.monotonic()
                run(['docker','run','--name',hls,'--label','cutmy.load-owner='+identifier,'--network','none','--cpus','3','--memory','4g','--pids-limit','256','--read-only','--cap-drop','ALL','--tmpfs','/tmp:size=512m,noexec,nosuid,nodev','-v',str(args.hls_test_binary.resolve())+':/usr/local/bin/hls.test:ro','-v',str(evidence)+':/evidence','--entrypoint','/usr/local/bin/hls.test',args.image,'-test.run=^TestHLSMiddleExportUsesGlobalTimelineAndRemovesStaging$','-test.count=1','-test.v','-test.cpuprofile=/evidence/hls.cpu.pprof','-test.memprofile=/evidence/hls.heap.pprof'],timeout=180,stdout=subprocess.DEVNULL)
                for path in evidence.iterdir():
                    if path.is_file():
                        __import__('shutil').copy2(path,args.output/path.name)
                report['hls']={'scope':'real MPEGTS/fMP4 staging + accurate MP4/MP3 controlled HTTPS engine regression, separate from API queue','seconds':round(time.monotonic()-started,4),'cpu_profile':'hls.cpu.pprof','heap_profile':'hls.heap.pprof','network_external_bytes':0}
            fields=['elapsed_seconds','server_rss_sum_bytes','server_ffmpeg_rss_bytes','server_memory_current_bytes','server_cpu_seconds','worker_rss_sum_bytes','worker_ffmpeg_rss_bytes','worker_memory_current_bytes','worker_cpu_seconds','queued_observed']
            with (args.output/'samples.csv').open('w',newline='') as output:
                writer=csv.DictWriter(output,fieldnames=fields)
                writer.writeheader()
                writer.writerows(samples)
            (args.output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps({key:report[key] for key in ('jobs_accepted','jobs_succeeded','jobs_failed','throughput_jobs_per_minute','queue_wait_seconds','server_total_seconds','cgroups')}))
    finally:
        stop.set()
        if sampler:
            sampler.join(timeout=5)
        remove_owned(identifier,containers,network_created,args.output)


if __name__=='__main__':
    def interrupted(_signal,_frame):
        raise RuntimeError('Isolated runner interrupted')
    signal.signal(signal.SIGTERM,interrupted)
    signal.signal(signal.SIGINT,interrupted)
    main()
