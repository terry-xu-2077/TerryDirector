/* H3 command catalog and token labels adapted from Terry's H3 editor.
 * Source: terry-xu-2077/ComfyUI-TerryXu-nodes @ 97263bca7ca1e40348a273244e5feebb9877126b
 * web/h3_shared_menus.js + web/h3_rich_text.js. See docs/H3_EDITOR_PORT.md.
 * Only the host integration changes; command raw values remain H3 syntax. */
(function (root) {
  'use strict';
  const cameras = [
    ['推进','Push In','镜头向主体推进','The camera pushes in '],
    ['拉远','Pull Out','镜头向后拉远','The camera pulls out '],
    ['左摇','Pan Left','镜头水平向左摇动','The camera pans left '],
    ['右摇','Pan Right','镜头水平向右摇动','The camera pans right '],
    ['左移','Truck Left','摄像机整体向左平移','The camera trucks left '],
    ['右移','Truck Right','摄像机整体向右平移','The camera trucks right '],
    ['上摇','Tilt Up','镜头向上俯仰摇动','The camera tilts up '],
    ['下摇','Tilt Down','镜头向下俯仰摇动','The camera tilts down '],
    ['升镜','Pedestal Up','摄像机整体向上升起','The camera moves upward '],
    ['降镜','Pedestal Down','摄像机整体向下降低','The camera moves downward '],
    ['环绕','Arc Shot','摄像机沿弧线环绕主体','The camera moves in an arc around the subject '],
    ['跟拍','Tracking Shot','镜头跟随移动中的主体','The camera follows the moving subject in a tracking shot '],
    ['固定镜头','Static Shot','摄像机保持固定不动','The camera holds a static shot '],
    ['变焦推近','Zoom In','通过镜头变焦放大画面','The camera zooms in '],
    ['变焦拉远','Zoom Out','通过镜头变焦缩小画面','The camera zooms out '],
    ['第一人称视角','POV','使用角色的主观视角','POV, '],
    ['顺时针旋转','Roll Clockwise','镜头沿光轴顺时针旋转','The camera rolls clockwise '],
    ['逆时针旋转','Roll Counterclockwise','镜头沿光轴逆时针旋转','The camera rolls counterclockwise '],
    ['轻微晃动','Shake Slightly','镜头产生轻微手持晃动','The camera shakes slightly '],
    ['强烈晃动','Shake Strongly','镜头产生明显剧烈晃动','The camera shakes strongly ']
  ];
  const sections = [
    ['subject_definitions','主体定义','定义 Subject 内容单元，以及必要的 Picture / Video / Audio 资产角色'],
    ['summary','摘要','任务类型与主要引用关系摘要'],
    ['retention_analysis','保留关系分析','逐项说明引用内容如何被保留、迁移、复制或参考'],
    ['detailed_description','详细描述','逐镜头详细描述'],
    ['integrated_multimodal_description','综合多模态描述','T2VA / I2VA / FL2VA / L2VA 主字段'],
    ['overall_soundscape','整体声景','环境声、动作声与非语言人声汇总'],
    ['non_diegetic_music','非剧情音乐','非剧情内音乐']
  ];
  const retention = [
    ['fully_preserved','完整保留','定义的视觉引用角色被完整保留'],
    ['partially_preserved','部分保留','仍使用引用内容，但部分定义特征被改变'],
    ['attribute_transfer','属性迁移','把引用特征迁移到另一个可识别主体'],
    ['weak_reference','弱参考','仅保留宽泛风格、类别、构图或氛围'],
    ['fully_copy','完整复制','完整复制源音频信号'],
    ['partially_copy','部分复制','只复制部分时间或音频层'],
    ['reference','参考','不复制信号，仅参考音色、节奏、内容或声音质感']
  ];
  const tasks = [
    ['reference generation','参考生成','参考生成'],
    ['keyframe completion','关键帧补全','图片作为具体首帧/关键帧/末帧等帧锚点'],
    ['video editing','视频编辑','直接编辑已有视频'],
    ['video continuation','视频续写','从已有视频继续生成'],
    ['audio reuse','音频复用','直接复用同一音频信号'],
    ['audio reference','音频参考','只参考音频特征而不复制信号']
  ];
  const categories = [
    {id:'structure',label:'结构',icon:'§',detail:'H3 主字段与段落'},
    {id:'shot',label:'镜头',icon:'▣',detail:'镜头标签、时间戳、说话人与镜头运动'},
    {id:'dialogue',label:'对白',icon:'“',detail:'对白块与连续性标签'},
    {id:'retention',label:'保留关系',icon:'◎',detail:'视觉与音频引用关系'},
    {id:'task',label:'任务类型',icon:'▤',detail:'Summary 的任务类型前缀'}
  ];
  const cameraCategory={id:'camera',label:'镜头运动',icon:'◉',detail:'常用运镜方式与镜头运动',parent:'shot'};
  const languages=[['English','英语'],['Chinese','中文'],['Cantonese','粤语'],['Japanese','日语'],['Korean','韩语'],['Spanish','西班牙语'],['French','法语'],['German','德语'],['Italian','意大利语'],['Portuguese','葡萄牙语'],['Russian','俄语'],['Arabic','阿拉伯语'],['Hindi','印地语'],['Thai','泰语'],['Vietnamese','越南语'],['Indonesian','印尼语'],['Turkish','土耳其语'],['Polish','波兰语'],['Dutch','荷兰语'],['Other','其他']];
  const reEscape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  // Same H3 grammar as the source; legacy Chinese demo labels are retained losslessly.
  const base=/<d>\[[^\]]+\][\s\S]*?<\/d>|<(?:Subject|Picture|Video|Audio)\s+\d+>|\[Shot\s+\d+\]|\(S\d+\)|<scenetrans>|<cutoff>|\b(?:fully_preserved|partially_preserved|attribute_transfer|weak_reference|fully_copy|partially_copy|reference)\b|\[\d{2}:\d{2}\]|^(?:subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):|\[(?:reference generation|keyframe completion|video editing|video continuation|audio reuse|audio reference)(?:\s*\+[^\]]+)?\]/gmi;
  const pattern=()=>new RegExp(base.source+'|(?:'+cameras.map(c=>reEscape(c[3].trim())).sort((a,b)=>b.length-a.length).join('|')+')(?![\\w])|\\[(?:镜头\\s*\\d+|运镜|声音)\\]','gmi');
  const camera=raw=>cameras.find(c=>c[3].trim().toLowerCase()===raw.trim().toLowerCase());
  function tokenType(raw){
    const v=raw.trim();
    if(/^<d>\[/i.test(v))return 'dialogue';
    const m=v.match(/^<(Subject|Picture|Video|Audio)\s+\d+>$/i);if(m)return m[1].toLowerCase();
    if(/^\[(?:Shot\s+|镜头\s*)\d+\]$/i.test(v))return 'shot';
    if(/^\(S\d+\)$/i.test(v))return 'speaker';
    if(/^\[\d{2}:\d{2}\]$/.test(v))return 'time';
    if(sections.some(s=>v.toLowerCase()===s[0]+':'))return 'section';
    if(retention.some(s=>v.toLowerCase()===s[0]))return 'retention';
    if(tasks.some(s=>v.toLowerCase().startsWith('['+s[0])))return 'task';
    if(/^<(scenetrans|cutoff)>$/i.test(v))return 'transition';
    if(camera(v)||v==='[运镜]')return 'camera';if(v==='[声音]')return 'audio';
    return 'plain';
  }
  function label(raw){
    const v=raw.trim();
    for(const [en,zh] of sections)if(v.toLowerCase()===en+':')return zh;
    for(const [en,zh] of retention)if(v.toLowerCase()===en)return zh;
    for(const [en,zh] of tasks)if(v.toLowerCase()==='['+en+']')return zh;
    if(v.toLowerCase()==='<scenetrans>')return '跨镜头连续';if(v.toLowerCase()==='<cutoff>')return '结尾截断';
    if(camera(v))return camera(v)[0];
    let m=v.match(/^<(Subject|Picture|Video|Audio)\s+(\d+)>$/i);if(m)return ({subject:'主体',picture:'图片',video:'视频',audio:'音频'})[m[1].toLowerCase()]+' '+m[2];
    m=v.match(/^\[(?:Shot\s+|镜头\s*)(\d+)\]$/i);if(m)return '镜头 '+m[1];
    m=v.match(/^\(S(\d+)\)$/i);if(m)return '说话人 S'+m[1];
    m=v.match(/^\[(\d{2}:\d{2})\]$/);if(m)return '时间 '+m[1];
    return v.replace(/^\[(运镜|声音)\]$/,'$1');
  }
  function nextNumber(text,re){let max=0;for(const m of text.matchAll(re))max=Math.max(max,+m[1]||0);return max+1;}
  function commands(text=''){
    const shot=nextNumber(text,/\[\s*Shot\s+(\d+)\s*\]/gi),speaker=nextNumber(text,/\(S(\d+)\)/gi);
    return [
      ...sections.map(([en,zh,detail])=>({category:'structure',label:en,zh,detail,raw:en+':',...(en==='non_diegetic_music'?{defaultBody:'N/A'}:{})})),
      {category:'shot',label:`[Shot ${shot}]`,zh:'镜头',detail:`插入第 ${shot} 个镜头分段标签`,raw:`[Shot ${shot}]`,kind:'shot-label'},
      {category:'shot',label:'时间戳',detail:'插入秒级时间标签 [00:00]',raw:'[00:00]',kind:'timestamp'},
      {category:'shot',label:`说话人 S${speaker}`,detail:'插入下一个全局说话人编号',raw:`(S${speaker})`,kind:'speaker'},
      {category:'dialogue',label:'对白块',detail:'插入可编辑对白块',raw:'<d>[Chinese] </d>',kind:'dialogue'},
      {category:'dialogue',label:'scenetrans',zh:'跨镜头连续',detail:'对白或音频跨镜头连续',raw:'<scenetrans>'},
      {category:'dialogue',label:'cutoff',zh:'结尾截断',detail:'对白被镜头或剪辑截断',raw:'<cutoff>'},
      ...retention.map(([raw,zh,detail])=>({category:'retention',label:raw,zh,detail,raw})),
      ...tasks.map(([raw,zh,detail])=>({category:'task',label:raw,zh,detail,raw:'['+raw+']'})),
      ...cameras.map(([zh,en,detail,raw])=>({category:'camera',label:zh+' · '+en,zh,detail,raw}))
    ];
  }
  root.TDH3Syntax={cameras,sections,retention,tasks,categories,cameraCategory,languages,pattern,tokenType,label,commands};
  if(typeof module!=='undefined')module.exports=root.TDH3Syntax;
})(typeof window==='undefined'?globalThis:window);
