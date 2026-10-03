const COLORS=['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e','#d35400','#16a085','#8e44ad','#27ae60','#c0392b','#2980b9','#7f8c8d','#2c3e50'];
const DEFAULT_CENTER=[35.12339,126.8829774];
const map=L.map('map',{preferCanvas:true,zoomControl:true}).setView(DEFAULT_CENTER,15);
async function addKoreanBasemap(){
  try{
    const style=await fetch('https://tiles.openfreemap.org/styles/liberty').then(r=>r.json());
    for(const layer of (style.layers||[])){
      if(layer.type!=='symbol'||!layer.layout||!layer.layout['text-field']) continue;
      const raw=JSON.stringify(layer.layout['text-field']);
      if(!/name/.test(raw)) continue;
      layer.layout['text-field']=['coalesce',['get','name:ko'],['get','name'],layer.layout['text-field']];
    }
    L.maplibreGL({style}).addTo(map);
  }catch(e){
    L.maplibreGL({style:'https://tiles.openfreemap.org/styles/liberty'}).addTo(map);
  }
}
addKoreanBasemap();

const densityMap=L.map('densityMap',{preferCanvas:true,zoomControl:true,attributionControl:true}).setView(DEFAULT_CENTER,15);
L.maplibreGL({style:'https://tiles.openfreemap.org/styles/liberty'}).addTo(densityMap);
let densityGridLayer=null,densityBoundaryLayer=null;

let analysisMode='radius',currentData=null,activeCategory=null,activeMidCategory=null,radiusLayer=null,centerLayer=null,polygonLayer=null,legend=null,deferredInstallPrompt=null,colorMap={};
const storeLayer=L.layerGroup().addTo(map),markers=[],drawnItems=new L.FeatureGroup().addTo(map);
const ids=['address','radiusPreset','radius','customRadiusWrap','searchBtn','exportBtn','installBtn','status','total','totalLabel','largeCount','topCategory','topCategoryCount','radiusKpi','areaLabel','centerName','categoryList','midCategoryList','resetFilterBtn','storeSearch','storeList','storeListCaption','radiusModeBtn','polygonModeBtn','radiusControls','polygonControls','polygonHelp','locateBtn','drawPolygonBtn','clearPolygonBtn','polygonSearchBtn','densityCategory','densityArea','densityAll','densitySelected','densitySelectedLabel','largeCategorySelect','midCategorySelect','clearIndustryFilterBtn','industryFilterStatus'];
const el=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
const esc=v=>String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const radius=()=>el.radiusPreset.value==='custom'?Number(el.radius.value):Number(el.radiusPreset.value);
const radiusText=r=>r>=1000?`${(r/1000).toLocaleString('ko-KR',{maximumFractionDigits:1})}km`:`${r.toLocaleString()}m`;
function status(msg,kind=''){el.status.textContent=msg;el.status.dataset.kind=kind}
function buildColors(rows){colorMap={};rows.forEach((r,i)=>colorMap[r.name]=COLORS[i%COLORS.length])}
const colorOf=n=>colorMap[n]||'#6d8398';
function countBy(stores,prop){const m=new Map();for(const s of stores){const n=String(s[prop]||'기타').trim()||'기타';m.set(n,(m.get(n)||0)+1)}return[...m].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count||a.name.localeCompare(b.name,'ko'))}
function haversine(a,b){const R=6371000,toRad=x=>x*Math.PI/180,dLat=toRad(b.lat-a.lat),dLon=toRad(b.lon-a.lon),la1=toRad(a.lat),la2=toRad(b.lat);const h=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
function polygonAreaMeters(points){if(points.length<3)return 0;const lat0=points.reduce((s,p)=>s+p.lat,0)/points.length*Math.PI/180,R=6371000;const xy=points.map(p=>({x:R*p.lng*Math.PI/180*Math.cos(lat0),y:R*p.lat*Math.PI/180}));let a=0;for(let i=0,j=xy.length-1;i<xy.length;j=i++)a+=(xy[j].x*xy[i].y-xy[i].x*xy[j].y);return Math.abs(a/2)}
function pointInPolygon(lat,lon,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const xi=poly[i].lng,yi=poly[i].lat,xj=poly[j].lng,yj=poly[j].lat;const intersect=((yi>lat)!==(yj>lat))&&(lon<(xj-xi)*(lat-yi)/(yj-yi+Number.EPSILON)+xi);if(intersect)inside=!inside}return inside}
function polygonCenter(poly){return{lat:poly.reduce((s,p)=>s+p.lat,0)/poly.length,lon:poly.reduce((s,p)=>s+p.lng,0)/poly.length}}
function metersToLat(m){return m/111320}
function metersToLon(m,lat){const cos=Math.cos(lat*Math.PI/180);return m/(111320*(Math.abs(cos)<0.01?0.01:cos))}
function densityCellSizeMeters(){
  if(!currentData)return 60;
  if(currentData.query?.mode==='polygon')return 50;
  const r=Number(currentData.query?.radius||500);
  if(r<=300)return 30;
  if(r<=500)return 40;
  if(r<=1000)return 55;
  if(r<=1500)return 65;
  return 80;
}
function getDensityBounds(){
  if(currentData?.query?.mode==='polygon'&&polygonLayer)return polygonLayer.getBounds();
  if(currentData?.center&&currentData?.query?.radius){
    return L.circle([currentData.center.lat,currentData.center.lon],{radius:Number(currentData.query.radius)}).getBounds();
  }
  if(currentData?.stores?.length)return L.latLngBounds(currentData.stores.map(s=>[s.lat,s.lon]));
  return null;
}
function pointInsideDensityArea(lat,lon){
  if(currentData?.query?.mode==='polygon'&&polygonLayer){
    const poly=polygonLayer.getLatLngs()[0];
    return pointInPolygon(lat,lon,poly);
  }
  if(currentData?.center&&currentData?.query?.radius){
    return haversine({lat,lon},{lat:currentData.center.lat,lon:currentData.center.lon})<=Number(currentData.query.radius||0);
  }
  return true;
}
function buildDensityGrid(stores){
  const bounds=getDensityBounds();
  if(!bounds)return[];
  const south=bounds.getSouth(),north=bounds.getNorth(),west=bounds.getWest(),east=bounds.getEast();
  const centerLat=(south+north)/2;
  const cellMeters=densityCellSizeMeters();
  const latStep=metersToLat(cellMeters),lonStep=metersToLon(cellMeters,centerLat);
  const rows=Math.max(1,Math.ceil((north-south)/latStep));
  const cols=Math.max(1,Math.ceil((east-west)/lonStep));
  const counts=new Map();
  for(const s of stores){
    if(!pointInsideDensityArea(s.lat,s.lon))continue;
    const row=Math.max(0,Math.min(rows-1,Math.floor((s.lat-south)/latStep)));
    const col=Math.max(0,Math.min(cols-1,Math.floor((s.lon-west)/lonStep)));
    const key=row+'_'+col;
    counts.set(key,(counts.get(key)||0)+1);
  }
  const cells=[];
  for(let row=0;row<rows;row++){
    for(let col=0;col<cols;col++){
      const cSouth=south+row*latStep,cNorth=Math.min(north,cSouth+latStep);
      const cWest=west+col*lonStep,cEast=Math.min(east,cWest+lonStep);
      const midLat=(cSouth+cNorth)/2,midLon=(cWest+cEast)/2;
      if(!pointInsideDensityArea(midLat,midLon))continue;
      cells.push({count:counts.get(row+'_'+col)||0,bounds:[[cSouth,cWest],[cNorth,cEast]]});
    }
  }
  return cells;
}
const DENSITY_COLORS=['#fff5f0','#fee0d2','#fcbba1','#fc9272','#fb6a4a','#cb181d','#99000d'];
function densityStepIndex(value,max){
  if(value<=0||max<=0)return 0;
  const ratio=value/max;
  if(ratio<=0.16)return 1;
  if(ratio<=0.32)return 2;
  if(ratio<=0.48)return 3;
  if(ratio<=0.64)return 4;
  if(ratio<=0.82)return 5;
  return 6;
}
function densityStepColor(value,max){return DENSITY_COLORS[densityStepIndex(value,max)]}
function analysisAreaHa(){
  if(!currentData)return 0;
  if(currentData.query?.mode==='polygon'&&polygonLayer){
    const pts=polygonLayer.getLatLngs()[0];
    return polygonAreaMeters(pts)/10000;
  }
  const r=Number(currentData.query?.radius||0);
  return r>0?Math.PI*r*r/10000:0;
}
function populateDensityCategories(){
  if(!el.densityCategory||!currentData)return;
  const prev=el.densityCategory.value;
  el.densityCategory.innerHTML='<option value="">전체 업종</option>'+currentData.countsLarge.map(x=>`<option value="${esc(x.name)}">${esc(x.name)} (${x.count.toLocaleString()}개)</option>`).join('');
  if([...el.densityCategory.options].some(o=>o.value===prev))el.densityCategory.value=prev;
}
function renderDensity(){
  if(!currentData||!densityMap)return;
  const areaHa=analysisAreaHa();
  const selected=el.densityCategory?.value||'';
  const rows=selected?currentData.stores.filter(s=>s.largeCategory===selected):currentData.stores;

  el.densityArea.textContent=areaHa>0?areaHa.toLocaleString('ko-KR',{maximumFractionDigits:2}):'-';
  el.densityAll.textContent=areaHa>0?(currentData.total/areaHa).toLocaleString('ko-KR',{maximumFractionDigits:2}):'-';
  el.densitySelected.textContent=areaHa>0?(rows.length/areaHa).toLocaleString('ko-KR',{maximumFractionDigits:2}):'-';
  el.densitySelectedLabel.textContent=selected?`${selected} 점포밀도`:'전체 업종 점포밀도';

  if(densityGridLayer){densityMap.removeLayer(densityGridLayer);densityGridLayer=null}
  if(densityBoundaryLayer){densityMap.removeLayer(densityBoundaryLayer);densityBoundaryLayer=null}

  const cells=buildDensityGrid(rows);
  const maxCount=Math.max(0,...cells.map(x=>x.count));
  densityGridLayer=L.layerGroup();

  for(const cell of cells){
    const step=densityStepIndex(cell.count,maxCount);
    const rect=L.rectangle(cell.bounds,{
      color:step===0?'#ffffff':'rgba(255,255,255,.78)',
      weight:step===0?0.15:0.45,
      opacity:0.75,
      fillColor:densityStepColor(cell.count,maxCount),
      fillOpacity:step===0?0.12:0.72
    });
    if(cell.count>0){
      rect.bindTooltip(`밀집도 ${step}단계 · 점포 ${cell.count.toLocaleString()}개`,{sticky:true,direction:'top'});
    }
    rect.addTo(densityGridLayer);
  }
  densityGridLayer.addTo(densityMap);

  if(currentData.query?.mode==='polygon'&&polygonLayer){
    const poly=polygonLayer.getLatLngs()[0];
    densityBoundaryLayer=L.polygon(poly,{color:'#17324d',weight:3,fill:false,dashArray:'6 4'}).addTo(densityMap);
    densityMap.fitBounds(densityBoundaryLayer.getBounds(),{padding:[18,18]});
  }else if(currentData.center&&currentData.query?.radius){
    densityBoundaryLayer=L.circle([currentData.center.lat,currentData.center.lon],{radius:currentData.query.radius,color:'#17324d',weight:2.5,fill:false,dashArray:'6 4'}).addTo(densityMap);
    densityMap.fitBounds(densityBoundaryLayer.getBounds(),{padding:[18,18]});
  }else if(rows.length){
    densityMap.fitBounds(L.latLngBounds(rows.map(s=>[s.lat,s.lon])),{padding:[18,18]});
  }
  setTimeout(()=>densityMap.invalidateSize(),50);
}
function populateIndustryFilters(){
  if(!currentData||!el.largeCategorySelect||!el.midCategorySelect)return;
  const prevLarge=activeCategory||'';
  const prevMid=activeMidCategory||'';
  el.largeCategorySelect.innerHTML='<option value="">전체 대분류</option>'+currentData.countsLarge.map(x=>`<option value="${esc(x.name)}">${esc(x.name)} (${x.count.toLocaleString()}개)</option>`).join('');
  if(prevLarge&&[...el.largeCategorySelect.options].some(o=>o.value===prevLarge))el.largeCategorySelect.value=prevLarge;
  refreshMidCategoryOptions(prevMid);
}
function refreshMidCategoryOptions(preferred=''){
  if(!currentData||!el.midCategorySelect)return;
  const large=el.largeCategorySelect?.value||activeCategory||'';
  const base=large?currentData.stores.filter(s=>s.largeCategory===large):[];
  const counts=countBy(base,'midCategory');
  el.midCategorySelect.innerHTML='<option value="">전체 중분류</option>'+counts.map(x=>`<option value="${esc(x.name)}">${esc(x.name)} (${x.count.toLocaleString()}개)</option>`).join('');
  el.midCategorySelect.disabled=!large;
  if(large&&preferred&&[...el.midCategorySelect.options].some(o=>o.value===preferred))el.midCategorySelect.value=preferred;
  else el.midCategorySelect.value='';
}
function updateIndustryFilterStatus(){
  if(!el.industryFilterStatus)return;
  const parts=[];
  if(activeCategory)parts.push(activeCategory);
  if(activeMidCategory)parts.push(activeMidCategory);
  if(parts.length){
    el.industryFilterStatus.textContent=parts.join(' > ')+' 선택 중';
    el.industryFilterStatus.classList.add('active');
  }else{
    el.industryFilterStatus.textContent='전체 업종 표시 중';
    el.industryFilterStatus.classList.remove('active');
  }
}
function applyIndustrySelection(large='',mid=''){
  activeCategory=large||null;
  activeMidCategory=mid||null;
  if(el.largeCategorySelect)el.largeCategorySelect.value=activeCategory||'';
  refreshMidCategoryOptions(activeMidCategory||'');
  if(el.midCategorySelect&&activeMidCategory)el.midCategorySelect.value=activeMidCategory;
  applyFilters();
  if(currentData)renderCounts(el.categoryList,currentData.countsLarge,true);
  updateIndustryFilterStatus();
}
function renderCounts(target,rows,clickable=false){if(!rows?.length){target.innerHTML='<div class="emptyCard">조회 결과 없음</div>';return}const max=Math.max(...rows.map(x=>x.count));target.innerHTML=rows.map(x=>{const c=colorOf(x.name),sel=clickable&&activeCategory===x.name?' selected':'';return `<button type="button" class="categoryRow${sel}" style="--category-color:${c}" ${clickable?`data-category="${esc(x.name)}"`:'disabled'}><span class="categoryMain"><span class="categoryName"><i class="categoryDot"></i>${esc(x.name)}</span><span class="bar"><i style="width:${Math.max(5,x.count/max*100)}%"></i></span></span><b>${x.count.toLocaleString()}개</b></button>`}).join('');if(clickable)target.querySelectorAll('[data-category]').forEach(b=>b.addEventListener('click',()=>{const clicked=b.dataset.category;if(activeCategory===clicked&&!activeMidCategory)applyIndustrySelection('','');else applyIndustrySelection(clicked,'')}))}
function renderLegend(rows){if(legend){legend.remove();legend=null}if(!rows.length)return;legend=L.control({position:'bottomleft'});legend.onAdd=()=>{const d=L.DomUtil.create('div','mapLegend');d.innerHTML='<strong>업종 색상</strong>'+rows.slice(0,12).map(r=>`<div class="legendItem"><i style="background:${colorOf(r.name)}"></i><span>${esc(r.name)}</span></div>`).join('');L.DomEvent.disableClickPropagation(d);return d};legend.addTo(map)}
function addMarker(s){const c=colorOf(s.largeCategory);const m=L.circleMarker([s.lat,s.lon],{radius:5,weight:1.3,color:c,fillColor:c,fillOpacity:.84});m.bindPopup(`<b>${esc(s.name)}</b>${s.branch?` ${esc(s.branch)}`:''}<br>${esc(s.largeCategory)} &gt; ${esc(s.midCategory)} &gt; ${esc(s.smallCategory)}<br>${esc(s.address||s.lotAddress)}`);m.__store=s;markers.push(m);storeLayer.addLayer(m)}
function clearMapAnalysis(){storeLayer.clearLayers();markers.length=0;if(radiusLayer){radiusLayer.remove();radiusLayer=null}if(centerLayer){centerLayer.remove();centerLayer=null}if(legend){legend.remove();legend=null}}
function updateSummary(data){el.total.textContent=data.total.toLocaleString();el.largeCount.textContent=data.countsLarge.length.toLocaleString();if(data.countsLarge[0]){el.topCategory.textContent=data.countsLarge[0].name;el.topCategoryCount.textContent=`${data.countsLarge[0].count.toLocaleString()}개 · ${(data.countsLarge[0].count/Math.max(1,data.total)*100).toFixed(1)}%`}else{el.topCategory.textContent='-';el.topCategoryCount.textContent='-'}renderCounts(el.categoryList,data.countsLarge,true);renderCounts(el.midCategoryList,data.countsMid,false);renderStores(data.stores);el.storeSearch.disabled=false;el.exportBtn.disabled=false;populateIndustryFilters();updateIndustryFilterStatus();populateDensityCategories();renderDensity()}
function drawRadius(data){currentData=data;activeCategory=null;activeMidCategory=null;el.storeSearch.value='';buildColors(data.countsLarge);clearMapAnalysis();const p=[data.center.lat,data.center.lon];radiusLayer=L.circle(p,{radius:data.query.radius,weight:2.2,fillOpacity:.045}).addTo(map);centerLayer=L.marker(p,{icon:L.divIcon({className:'',html:'<div class="centerMarker"></div>',iconSize:[20,20],iconAnchor:[10,10]})}).bindPopup(`<b>분석 기준점</b><br>${esc(data.center.displayName||data.query.address)}<br>반경 ${radiusText(data.query.radius)}`).addTo(map);data.stores.forEach(addMarker);renderLegend(data.countsLarge);map.fitBounds(radiusLayer.getBounds(),{padding:[18,18]});el.totalLabel.textContent='반경 내 점포';el.areaLabel.textContent='분석 반경';el.radiusKpi.textContent=radiusText(data.query.radius);el.centerName.textContent=data.query.address;updateSummary(data)}
function drawPolygonResult(data,poly,searchRadius){currentData=data;activeCategory=null;activeMidCategory=null;el.storeSearch.value='';buildColors(data.countsLarge);clearMapAnalysis();data.stores.forEach(addMarker);renderLegend(data.countsLarge);if(polygonLayer)polygonLayer.setStyle({color:'#17324d',weight:3,fillOpacity:.08});map.fitBounds(L.latLngBounds(poly.map(p=>[p.lat,p.lng])),{padding:[22,22]});const area=polygonAreaMeters(poly);el.totalLabel.textContent='다각형 내 점포';el.areaLabel.textContent='다각형 면적';el.radiusKpi.textContent=area>=1e6?`${(area/1e6).toFixed(2)}㎢`:`${Math.round(area).toLocaleString()}㎡`;el.centerName.textContent=`검색반경 ${radiusText(searchRadius)}`;updateSummary(data)}
function matches(s,t){if(!t)return true;return[s.name,s.branch,s.largeCategory,s.midCategory,s.smallCategory,s.address,s.lotAddress].join(' ').toLowerCase().includes(t.toLowerCase())}
function filtered(){if(!currentData)return[];const t=el.storeSearch.value.trim();return currentData.stores.filter(s=>(!activeCategory||s.largeCategory===activeCategory)&&(!activeMidCategory||s.midCategory===activeMidCategory)&&matches(s,t))}
function renderStores(rows){const filterName=activeMidCategory?`${activeCategory} > ${activeMidCategory}`:activeCategory;el.storeListCaption.textContent=filterName?`${filterName} ${rows.length.toLocaleString()}개 점포 표시 중`:`${rows.length.toLocaleString()}개 점포 표시 중`;if(!rows.length){el.storeList.innerHTML='<div class="emptyCard">조건에 맞는 점포가 없음</div>';return}el.storeList.innerHTML=rows.slice(0,500).map(s=>`<article class="storeItem"><div class="storeTop"><div class="storeName">${esc(s.name)}${s.branch?` <small>${esc(s.branch)}</small>`:''}</div><span class="storeCategory"><i class="categoryDot" style="background:${colorOf(s.largeCategory)}"></i>${esc(s.largeCategory)}</span></div><div class="storeMeta">${esc(s.midCategory)} · ${esc(s.smallCategory)}<br>${esc(s.address||s.lotAddress)}</div></article>`).join('')}
function applyFilters(){const rows=filtered();storeLayer.clearLayers();for(const m of markers)if(rows.includes(m.__store))storeLayer.addLayer(m);renderStores(rows)}
function explain(d){const c=d?.code,e=String(d?.error||'');if(c==='SERVICE_KEY_MISSING')return'백엔드 서버에 공공데이터 인증키가 설정되지 않음';if(c==='ADDRESS_GEOCODING_FAILED')return'주소 좌표를 찾지 못함. 지번 또는 도로명주소를 더 정확히 입력해야 함';if(c==='PUBLIC_DATA_FORBIDDEN')return'공공데이터 API 접근이 거부됨. 활용신청·인증키 상태를 확인해야 함';if(c==='NETWORK_TO_PUBLIC_DATA_FAILED')return'백엔드 서버에서 공공데이터포털에 연결하지 못함';if(c==='PUBLIC_DATA_API_ERROR'||c==='PUBLIC_DATA_HTTP_ERROR')return`공공데이터 API 오류임${e?`: ${e}`:''}`;return e||'조회 중 오류가 발생함'}
async function radiusSearch(){const a=el.address.value.trim(),r=radius();if(!a)return status('주소를 입력해야 함','error');if(!Number.isFinite(r)||r<50||r>2000)return status('반경은 50m~2,000m로 입력해야 함','error');el.searchBtn.disabled=true;status('좌표 확인 및 점포 조회 중…');try{const q=new URLSearchParams({address:a,radius:String(r)}),res=await fetch(`/api/stores?${q}`,{cache:'no-store'}),d=await res.json();if(!res.ok)throw new Error(explain(d));drawRadius(d);status(`${d.total.toLocaleString()}개 점포 분석 완료`,'success')}catch(e){status(`오류: ${e.message}`,'error')}finally{el.searchBtn.disabled=false}}
async function locateAddress(){const a=el.address.value.trim();if(!a)return status('주소를 입력해야 함','error');el.locateBtn.disabled=true;status('주소 좌표 확인 중…');try{const q=new URLSearchParams({address:a}),r=await fetch(`/api/geocode?${q}`,{cache:'no-store'}),d=await r.json();if(!r.ok)throw new Error(explain(d));map.setView([d.lat,d.lon],16);status('지도 이동 완료. 이제 다각형을 그려야 함','success')}catch(e){status(`오류: ${e.message}`,'error')}finally{el.locateBtn.disabled=false}}
const polygonDrawer=new L.Draw.Polygon(map,{allowIntersection:false,showArea:true,shapeOptions:{color:'#17324d',weight:3,fillOpacity:.08}});
function startPolygonDraw(){if(polygonLayer){drawnItems.removeLayer(polygonLayer);polygonLayer=null}polygonDrawer.enable();status('지도에서 꼭짓점을 선택하고 마지막 점을 첫 점과 연결하거나 더블클릭하여 완료함')}
function clearPolygon(){drawnItems.clearLayers();polygonLayer=null;el.polygonSearchBtn.disabled=true;status('다각형을 지웠음')}
map.on(L.Draw.Event.CREATED,e=>{drawnItems.clearLayers();polygonLayer=e.layer;drawnItems.addLayer(polygonLayer);el.polygonSearchBtn.disabled=false;const pts=polygonLayer.getLatLngs()[0];const area=polygonAreaMeters(pts);status(`다각형 설정 완료 · 면적 약 ${area>=1e6?(area/1e6).toFixed(2)+'㎢':Math.round(area).toLocaleString()+'㎡'}`,'success')});
async function polygonSearch(){if(!polygonLayer)return status('먼저 다각형을 그려야 함','error');const poly=polygonLayer.getLatLngs()[0];if(poly.length<3)return status('다각형은 꼭짓점이 3개 이상이어야 함','error');const center=polygonCenter(poly);let searchRadius=Math.ceil(Math.max(...poly.map(p=>haversine(center,{lat:p.lat,lon:p.lng})))+100);if(searchRadius>2000)return status('다각형이 너무 큼. 공공데이터 조회 한계에 맞게 중심에서 2km 이내로 그려야 함','error');searchRadius=Math.max(100,searchRadius);el.polygonSearchBtn.disabled=true;status('다각형 주변 점포 조회 후 내부 점포를 선별 중…');try{const q=new URLSearchParams({lat:String(center.lat),lon:String(center.lon),radius:String(searchRadius)}),r=await fetch(`/api/stores-coord?${q}`,{cache:'no-store'}),raw=await r.json();if(!r.ok)throw new Error(explain(raw));const stores=raw.stores.filter(s=>pointInPolygon(s.lat,s.lon,poly));const data={query:{mode:'polygon',address:el.address.value.trim(),radius:searchRadius},center,stores,total:stores.length,countsLarge:countBy(stores,'largeCategory'),countsMid:countBy(stores,'midCategory')};drawPolygonResult(data,poly,searchRadius);status(`${stores.length.toLocaleString()}개 점포가 다각형 내부에 있음`,'success')}catch(e){status(`오류: ${e.message}`,'error')}finally{el.polygonSearchBtn.disabled=false}}
function setMode(mode){analysisMode=mode;const poly=mode==='polygon';el.radiusModeBtn.classList.toggle('active',!poly);el.polygonModeBtn.classList.toggle('active',poly);el.radiusControls.classList.toggle('hidden',poly);el.polygonControls.classList.toggle('hidden',!poly);el.polygonHelp.classList.toggle('hidden',!poly);status(poly?'다각형 분석 모드임. 주소로 이동 후 영역을 그려야 함':'반경 분석 모드임');}
function csvCell(v){return `"${String(v??'').replaceAll('"','""')}"`}
function exportCsv(){if(!currentData)return;const rows=filtered(),h=['상가업소번호','상호','지점명','업종대분류','업종중분류','업종소분류','도로명주소','지번주소','위도','경도'],b=rows.map(s=>[s.id,s.name,s.branch,s.largeCategory,s.midCategory,s.smallCategory,s.address,s.lotAddress,s.lat,s.lon]);const csv='\uFEFF'+[h,...b].map(r=>r.map(csvCell).join(',')).join('\r\n'),blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`상권분석_${(currentData.query.address||analysisMode).replace(/[\\/:*?"<>|]/g,'_')}_${analysisMode}.csv`;a.click();URL.revokeObjectURL(a.href)}
el.radiusPreset.addEventListener('change',()=>{const c=el.radiusPreset.value==='custom';el.customRadiusWrap.classList.toggle('hidden',!c);if(!c)el.radius.value=el.radiusPreset.value});
el.radiusModeBtn.addEventListener('click',()=>setMode('radius'));el.polygonModeBtn.addEventListener('click',()=>setMode('polygon'));
el.searchBtn.addEventListener('click',radiusSearch);el.locateBtn.addEventListener('click',locateAddress);el.drawPolygonBtn.addEventListener('click',startPolygonDraw);el.clearPolygonBtn.addEventListener('click',clearPolygon);el.polygonSearchBtn.addEventListener('click',polygonSearch);
el.resetFilterBtn.addEventListener('click',()=>{el.storeSearch.value='';applyIndustrySelection('','')});el.storeSearch.addEventListener('input',applyFilters);el.exportBtn.addEventListener('click',exportCsv);el.address.addEventListener('keydown',e=>{if(e.key==='Enter'){analysisMode==='radius'?radiusSearch():locateAddress()}});
el.largeCategorySelect.addEventListener('change',()=>{
  const large=el.largeCategorySelect.value;
  applyIndustrySelection(large,'');
});
el.midCategorySelect.addEventListener('change',()=>{
  const large=el.largeCategorySelect.value;
  const mid=el.midCategorySelect.value;
  applyIndustrySelection(large,mid);
});
el.clearIndustryFilterBtn.addEventListener('click',()=>applyIndustrySelection('',''));
el.densityCategory.addEventListener('change',renderDensity);
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstallPrompt=e;el.installBtn.classList.remove('hidden')});el.installBtn.addEventListener('click',async()=>{if(!deferredInstallPrompt)return;deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;el.installBtn.classList.add('hidden')});window.addEventListener('appinstalled',()=>el.installBtn.classList.add('hidden'));if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js?v=8').catch(()=>{});
radiusSearch();
