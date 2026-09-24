import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/+esm";

const $ = id => document.getElementById(id);
const token = location.pathname.split('/').filter(Boolean).pop();
const video = $('video');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const work = $('workCanvas');
const wctx = work.getContext('2d', {willReadFrequently:true});

const steps = [
  {id:'center', label:'Look straight at the camera', kind:'center'},
  {id:'side_a', label:'Slowly turn your head to one side', kind:'sideA', threshold:0.055},
  {id:'side_a_deep', label:'Turn a little farther to the same side', kind:'sideA', threshold:0.105},
  {id:'center_mid', label:'Return to the center', kind:'center'},
  {id:'side_b', label:'Now turn to the other side', kind:'sideB', threshold:0.055},
  {id:'side_b_deep', label:'Turn a little farther to that side', kind:'sideB', threshold:0.105},
  {id:'up', label:'Look slightly upward', kind:'up'},
  {id:'down', label:'Look slightly downward', kind:'down'},
  {id:'center_final', label:'Return to center and hold still', kind:'center'}
];

let landmarker = null;
let running = false;
let stepIndex = 0;
let sideASign = 0;
let stableSince = 0;
let uploadBusy = false;
let lastVideoTime = -1;
let acceptedScores = [];
let lastMetrics = null;
let centerBaseline = null;

const limits = {
  minFaceWidth: 0.29,
  maxFaceWidth: 0.72,
  maxCenterOffset: 0.10,
  minBrightness: 65,
  maxBrightness: 205,
  minSharpness: 14,
  minQuality: 72,
  stableMs: 700
};

function showError(msg) { $('errorBox').textContent=msg; $('errorBox').classList.remove('hidden'); }
function clearError() { $('errorBox').classList.add('hidden'); }

async function loadSession() {
  try {
    const r = await fetch(`/api/enrollments/${token}/status`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || 'Unable to load enrollment');
    $('personName').textContent = `${data.employee_name} · ${data.employee_id}`;
  } catch(e) {
    showError(e.message);
    $('startBtn').disabled = true;
  }
}
loadSession();

$('startBtn').onclick = async () => {
  if (!$('consent').checked) return showError('You must provide biometric enrollment consent before the camera starts.');
  clearError();
  $('startBtn').disabled = true;
  $('startBtn').textContent = 'Preparing camera…';
  try {
    await initModel();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {width:{ideal:1920}, height:{ideal:1080}, frameRate:{ideal:30}, facingMode:'user'},
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    resizeCanvases();
    $('consentPanel').classList.add('hidden');
    $('cameraPanel').classList.remove('hidden');
    running = true;
    requestAnimationFrame(loop);
  } catch(e) {
    showError(`Camera/model initialization failed: ${e.message}. Use HTTPS (or localhost) and allow camera access.`);
    $('startBtn').disabled = false;
    $('startBtn').textContent = 'Start enrollment';
  }
};

async function initModel() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm"
  );
  landmarker = await FaceLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
      delegate: "GPU"
    },
    runningMode: "VIDEO",
    numFaces: 2,
    minFaceDetectionConfidence: 0.65,
    minFacePresenceConfidence: 0.65,
    minTrackingConfidence: 0.65,
    outputFaceBlendshapes: false
  });
}

function resizeCanvases() {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  work.width = video.videoWidth;
  work.height = video.videoHeight;
}
window.addEventListener('resize', () => { if (video.videoWidth) resizeCanvases(); });

function bbox(landmarks) {
  let minX=1,minY=1,maxX=0,maxY=0;
  for (const p of landmarks) { minX=Math.min(minX,p.x); minY=Math.min(minY,p.y); maxX=Math.max(maxX,p.x); maxY=Math.max(maxY,p.y); }
  return {minX,minY,maxX,maxY,w:maxX-minX,h:maxY-minY,cx:(minX+maxX)/2,cy:(minY+maxY)/2};
}

function pixelQuality() {
  const sw = 320, sh = Math.round(320 * video.videoHeight / video.videoWidth);
  work.width = sw; work.height = sh;
  wctx.drawImage(video, 0, 0, sw, sh);
  const {data} = wctx.getImageData(0,0,sw,sh);
  const gray = new Float32Array(sw*sh);
  let sum=0;
  for(let i=0,j=0;i<data.length;i+=4,j++) { const g=0.299*data[i]+0.587*data[i+1]+0.114*data[i+2]; gray[j]=g; sum+=g; }
  const brightness = sum/gray.length;
  let edgeSum=0, edgeSq=0, n=0;
  for(let y=1;y<sh-1;y+=2) for(let x=1;x<sw-1;x+=2) {
    const i=y*sw+x;
    const lap = 4*gray[i]-gray[i-1]-gray[i+1]-gray[i-sw]-gray[i+sw];
    edgeSum += lap; edgeSq += lap*lap; n++;
  }
  const mean=edgeSum/n;
  const variance=Math.max(0, edgeSq/n - mean*mean);
  const sharpness=Math.sqrt(variance);
  return {brightness, sharpness};
}

function poseValues(lm, box) {
  // Geometry heuristic for guided capture only, not a biometric descriptor.
  const nose = lm[1];
  const leftEyeOuter = lm[33];
  const rightEyeOuter = lm[263];
  const eyeMidX = (leftEyeOuter.x + rightEyeOuter.x)/2;
  const eyeMidY = (leftEyeOuter.y + rightEyeOuter.y)/2;
  const eyeDist = Math.max(0.0001, Math.abs(rightEyeOuter.x-leftEyeOuter.x));
  const yaw = (nose.x - eyeMidX) / eyeDist;
  const vertical = (nose.y - eyeMidY) / Math.max(0.0001, box.h);
  return {yaw, vertical};
}

function calcMetrics(result) {
  if (!result.faceLandmarks || result.faceLandmarks.length !== 1) return {faceCount: result.faceLandmarks?.length || 0, ok:false};
  const lm = result.faceLandmarks[0];
  const box = bbox(lm);
  const pix = pixelQuality();
  const pose = poseValues(lm, box);
  const faceSizeOk = box.w >= limits.minFaceWidth && box.w <= limits.maxFaceWidth;
  const centered = Math.abs(box.cx-0.5) <= limits.maxCenterOffset && Math.abs(box.cy-0.5) <= 0.14;
  const lightOk = pix.brightness >= limits.minBrightness && pix.brightness <= limits.maxBrightness;
  const sharpOk = pix.sharpness >= limits.minSharpness;
  const sizeScore = 100 - Math.min(100, Math.abs(box.w-0.46)*260);
  const centerScore = 100 - Math.min(100, (Math.abs(box.cx-.5)+Math.abs(box.cy-.5))*250);
  const lightScore = 100 - Math.min(100, Math.abs(pix.brightness-135)*0.9);
  const sharpScore = Math.min(100, pix.sharpness*4.1);
  const quality = Math.max(0, Math.min(100, 0.28*sizeScore+0.24*centerScore+0.23*lightScore+0.25*sharpScore));
  return {faceCount:1, ok:faceSizeOk&&centered&&lightOk&&sharpOk&&quality>=limits.minQuality, lm, box, ...pix, ...pose, faceSizeOk, centered, lightOk, sharpOk, quality};
}

function poseMatches(m) {
  const s = steps[stepIndex];
  if (!centerBaseline && s.kind==='center') centerBaseline = {vertical:m.vertical};
  const baselineV = centerBaseline?.vertical ?? m.vertical;
  if (s.kind==='center') return Math.abs(m.yaw) < 0.035 && Math.abs(m.vertical-baselineV) < 0.035;
  if (s.kind==='sideA') {
    if (sideASign === 0 && Math.abs(m.yaw) >= s.threshold) sideASign = Math.sign(m.yaw) || 1;
    return sideASign !== 0 && Math.sign(m.yaw) === sideASign && Math.abs(m.yaw) >= s.threshold;
  }
  if (s.kind==='sideB') return sideASign !== 0 && Math.sign(m.yaw) === -sideASign && Math.abs(m.yaw) >= s.threshold;
  if (s.kind==='up') return (m.vertical-baselineV) < -0.035;
  if (s.kind==='down') return (m.vertical-baselineV) > 0.035;
  return false;
}

function guidance(m) {
  const s = steps[stepIndex];
  $('instruction').textContent = s.label;
  $('stepBadge').textContent = `${stepIndex+1} / ${steps.length}`;
  $('progressBar').style.width = `${(stepIndex/steps.length)*100}%`;
  $('mFace').textContent = m.faceCount===1 ? 'Good' : (m.faceCount===0 ? 'Not found' : 'Multiple');
  $('mLight').textContent = m.lightOk ? 'Good' : (m.brightness<limits.minBrightness?'Too dark':'Too bright');
  $('mSharp').textContent = m.sharpOk ? 'Good' : 'Hold still';
  $('mPosition').textContent = (m.faceSizeOk && m.centered) ? 'Good' : (!m.faceSizeOk ? 'Adjust distance' : 'Center face');
  const poseOk = m.faceCount===1 && poseMatches(m);
  $('mPose').textContent = poseOk ? 'Good' : 'Move';
  $('mQuality').textContent = m.quality == null ? '—' : `${Math.round(m.quality)}/100`;
  if (m.faceCount!==1) return 'Only one face must be visible.';
  if (!m.lightOk) return m.brightness<limits.minBrightness ? 'Increase front lighting.' : 'Reduce harsh/overexposed lighting.';
  if (!m.sharpOk) return 'Hold still and clean the camera lens if needed.';
  if (!m.faceSizeOk) return m.box.w<limits.minFaceWidth ? 'Move closer to the camera.' : 'Move slightly farther from the camera.';
  if (!m.centered) return 'Center your face inside the oval.';
  if (!poseOk) return s.label;
  return 'Excellent — hold still.';
}

function draw(m) {
  octx.clearRect(0,0,overlay.width,overlay.height);
  if (!m || m.faceCount!==1) return;
  const b=m.box;
  octx.lineWidth=4;
  octx.strokeStyle=m.ok?'rgba(45,212,191,.95)':'rgba(250,204,21,.9)';
  octx.strokeRect(b.minX*overlay.width,b.minY*overlay.height,b.w*overlay.width,b.h*overlay.height);
}

async function loop(ts) {
  if (!running) return;
  try {
    if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const result = landmarker.detectForVideo(video, performance.now());
      const m = calcMetrics(result);
      lastMetrics=m; draw(m);
      $('hint').textContent = guidance(m);
      const poseOk = m.faceCount===1 && poseMatches(m);
      const allOk = m.ok && poseOk;
      if (allOk && !uploadBusy) {
        if (!stableSince) stableSince=performance.now();
        if (performance.now()-stableSince >= limits.stableMs) await acceptCurrentFrame(m);
      } else stableSince=0;
    }
  } catch(e) { console.error(e); }
  requestAnimationFrame(loop);
}

async function acceptCurrentFrame(m) {
  uploadBusy=true; stableSince=0;
  const step=steps[stepIndex];
  $('hint').textContent='Accepted — securely saving frame…';
  try {
    const captureCanvas=document.createElement('canvas');
    captureCanvas.width=video.videoWidth; captureCanvas.height=video.videoHeight;
    captureCanvas.getContext('2d').drawImage(video,0,0);
    const blob=await new Promise(resolve=>captureCanvas.toBlob(resolve,'image/jpeg',0.95));
    const metadata={
      quality:Number(m.quality.toFixed(2)), brightness:Number(m.brightness.toFixed(2)), sharpness:Number(m.sharpness.toFixed(2)),
      face_width_ratio:Number(m.box.w.toFixed(4)), face_center_x:Number(m.box.cx.toFixed(4)), face_center_y:Number(m.box.cy.toFixed(4)),
      yaw_heuristic:Number(m.yaw.toFixed(4)), vertical_heuristic:Number(m.vertical.toFixed(4)),
      source_width:video.videoWidth, source_height:video.videoHeight,
      quality_engine:'browser-mediapipe-guidance-v1'
    };
    const form=new FormData(); form.append('pose',step.id); form.append('metadata',JSON.stringify(metadata)); form.append('consent','true'); form.append('image',blob,`${step.id}.jpg`);
    const r=await fetch(`/api/enrollments/${token}/capture`,{method:'POST',body:form});
    const data=await r.json(); if(!r.ok) throw new Error(data.detail||'Upload failed');
    acceptedScores.push(m.quality);
    stepIndex++;
    if(stepIndex>=steps.length) return finishEnrollment();
    await new Promise(r=>setTimeout(r,450));
  } catch(e) { showError(e.message); }
  finally { uploadBusy=false; }
}

async function finishEnrollment() {
  running=false;
  const tracks=video.srcObject?.getTracks()||[]; tracks.forEach(t=>t.stop());
  const finalQuality=acceptedScores.reduce((a,b)=>a+b,0)/Math.max(1,acceptedScores.length);
  try {
    const r=await fetch(`/api/enrollments/${token}/complete`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({final_quality:finalQuality,consent:true,liveness_passed:true})});
    const data=await r.json(); if(!r.ok) throw new Error(data.detail||'Completion failed');
    $('cameraPanel').classList.add('hidden'); $('completePanel').classList.remove('hidden');
    $('completeText').textContent=`${data.capture_count} accepted views submitted. Average capture quality: ${Math.round(finalQuality)}/100.`;
    $('stepBadge').textContent='Complete';
  } catch(e) { showError(e.message); }
}
