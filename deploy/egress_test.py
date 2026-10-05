"""Exercise real kernel rules inside a disposable network namespace only."""
import os
from pathlib import Path
import shutil
import subprocess
import unittest

SCRIPT = Path(__file__).with_name("egress.sh").resolve()


class EgressTest(unittest.TestCase):
    def test_real_bridge_to_host_input_rejects_api_worker_only(self):
        if os.getuid()!=0 or not all(shutil.which(tool) for tool in ('unshare','nsenter','ip','iptables')):
            self.skipTest('Root/network namespaces unavailable')
        if subprocess.run(['unshare','--net','true'],capture_output=True).returncode:
            self.skipTest('Network namespaces unavailable')
        fixture=r'''
import subprocess,socket,threading,time,os
script=__import__('sys').argv[1]
def call(*args): subprocess.run(args,check=True,stdout=subprocess.DEVNULL)
call('ip','link','set','lo','up')
call('iptables','-N','DOCKER-USER')
call('iptables','-N','UNRELATED-HOST')
call('iptables','-A','UNRELATED-HOST','-j','RETURN')
call('iptables','-A','INPUT','-j','UNRELATED-HOST')
original=subprocess.check_output(['iptables','-S','UNRELATED-HOST'])
call('bash',script,'apply')
call('bash',script,'apply')
call('bash',script,'check')
rules=subprocess.check_output(['iptables','-S','INPUT']).decode()
assert rules.count('-s 172.30.240.10/32 -j CUTMY-HOST')==1
assert rules.count('-s 172.30.240.11/32 -j CUTMY-HOST')==1
call('ip','link','add','bridge0','type','bridge')
call('ip','address','add','172.30.240.1/24','dev','bridge0')
call('ip','address','add','8.8.8.8/32','dev','lo')
call('ip','link','set','bridge0','up')
call('ip','link','add','host0','type','veth','peer','name','client0')
call('ip','link','set','host0','master','bridge0')
call('ip','link','set','host0','up')
child=subprocess.Popen(['unshare','--net','python3','-u','-c','import os,time; print(os.getpid()); time.sleep(120)'],stdout=subprocess.PIPE)
listeners=[]
try:
    pid=child.stdout.readline().decode().strip()
    call('ip','link','set','client0','netns',pid)
    prefix=['nsenter','-t',pid,'-n']
    call(*prefix,'ip','link','set','lo','up')
    call(*prefix,'ip','link','set','client0','up')
    for source in ('172.30.240.10','172.30.240.11','172.30.240.20'):
        call(*prefix,'ip','address','add',source+'/24','dev','client0')
    call(*prefix,'ip','route','add','default','via','172.30.240.1')
    for port in (22,53,443):
        listener=socket.socket(); listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        listener.bind(('0.0.0.0',port)); listener.listen(32); listeners.append(listener)
    client=r"""
import socket
for source in ('172.30.240.10','172.30.240.11','172.30.240.20'):
 for destination in ('172.30.240.1','8.8.8.8'):
  for port in (22,53,443):
   with socket.socket() as connection:
    connection.bind((source,0)); connection.settimeout(.5)
    try: connection.connect((destination,port)); connected=True
    except OSError: connected=False
    assert connected==(source=='172.30.240.20'),(source,destination,port,connected)
"""
    call(*prefix,'python3','-c',client)
    counters=subprocess.check_output(['iptables','-nvxL','CUTMY-HOST']).decode()
    rejected=sum(int(line.split()[0]) for line in counters.splitlines() if 'REJECT' in line)
    assert rejected>=12,counters
    call('bash',script,'remove')
    assert subprocess.check_output(['iptables','-S','INPUT'])==b'-P INPUT ACCEPT\n-A INPUT -j UNRELATED-HOST\n'
    assert subprocess.check_output(['iptables','-S','UNRELATED-HOST'])==original
finally:
    for listener in listeners: listener.close()
    child.terminate(); child.wait(timeout=5)
'''
        result=subprocess.run(['unshare','--net','python3','-c',fixture,str(SCRIPT)],capture_output=True,text=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_rules_block_metadata_private_services_and_plain_http(self):
        if os.getuid() != 0 or not all(shutil.which(tool) for tool in ("unshare", "iptables", "ip")):
            self.skipTest("Kernel firewall drill requires root, iproute and netns")
        probe = subprocess.run(["unshare", "--net", "true"], capture_output=True)
        if probe.returncode:
            self.skipTest("Host does not permit isolated network namespaces")
        program = r'''
set -euo pipefail
iptables -N DOCKER-USER
iptables -N UNRELATED-SERVICE
iptables -A UNRELATED-SERVICE -j RETURN
iptables -A DOCKER-USER -j UNRELATED-SERVICE
before=$(iptables -S UNRELATED-SERVICE)
bash "$1" apply > /dev/null
bash "$1" apply > /dev/null
[[ $(iptables -S DOCKER-USER | rg -c '172.30.240.10/32') == 1 ]]
[[ "$before" == "$(iptables -S UNRELATED-SERVICE)" ]]
ip link add cutmy-fixture type dummy
ip address add 172.30.240.10/24 dev cutmy-fixture
ip link set cutmy-fixture up
ip link set lo up
ip route add default dev cutmy-fixture
# Exercise the same chain on namespace-generated packets rather than changing
# any host forwarding routes or requiring real remote endpoints.
iptables -I OUTPUT 1 -s 172.30.240.10/32 -j CUTMY-EGRESS
python3 - <<'PY'
import socket, subprocess
def rejects():
    output = subprocess.check_output(['iptables','-nvxL','CUTMY-EGRESS'], text=True)
    return sum(int(line.split()[0]) for line in output.splitlines() if 'REJECT' in line)
def attempt(address, port):
    with socket.socket() as connection:
        connection.bind(('172.30.240.10', 0))
        connection.settimeout(.15)
        try: connection.connect((address, port))
        except OSError: pass
for address, port in [('169.254.169.254',443),('10.1.2.3',443),('192.168.1.1',443),('172.30.240.12',80),('100.100.100.200',443),('1.1.1.1',80),('1.1.1.1',22),('172.30.240.1',53)]:
    before = rejects()
    attempt(address, port)
    assert rejects() > before, (address, port, 'was not rejected')
for address, port in [('172.30.240.12',5432),('1.1.1.1',443),('1.1.1.1',53)]:
    before = rejects()
    attempt(address, port)
    assert rejects() == before, (address, port, 'unexpected rejection')
PY
iptables -D OUTPUT -s 172.30.240.10/32 -j CUTMY-EGRESS
bash "$1" remove > /dev/null
[[ $(iptables -S DOCKER-USER) == $'-N DOCKER-USER\n-A DOCKER-USER -j UNRELATED-SERVICE' ]]
[[ "$before" == "$(iptables -S UNRELATED-SERVICE)" ]]
'''
        result = subprocess.run(["unshare", "--net", "bash", "-c", program, "fixture", str(SCRIPT)], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

    def test_missing_docker_user_chain_aborts_without_host_modification(self):
        if os.getuid() != 0 or not shutil.which("unshare"):
            self.skipTest("Root/network namespace unavailable")
        if subprocess.run(["unshare", "--net", "true"], capture_output=True).returncode:
            self.skipTest("Host does not permit isolated network namespaces")
        result = subprocess.run(["unshare", "--net", "bash", str(SCRIPT), "apply"], capture_output=True)
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
