To jump the version: 

node -e "let p=require('./package.json'); let v=p.version.split('.'); v[2]=String(Number(v[2]||0)+1); p.version=v.join('.'); require('fs').writeFileSync('package.json', JSON.stringify(p,null,2)); console.log('version bumped to',p.version)"


To coplile the project:

nvm run compile


To create the package:

vsce package


To debug the extension:

python3 tools/find_step.py --line 'Then the response should have an "fvc_drop" event triggered'
python3 tools/find_step.py --undefined
python3 tools/find_step.py --index