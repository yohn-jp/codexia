/*
 * Codexia — Literary Identity / Optical Icon System
 * Canonical, dependency-free SVG generator. Four hand-tuned optical masters.
 * Node: const { renderIcon } = require('./src/icon.js');
 * Browser: window.CodexiaIcon.renderIcon(...)
 * No SVG icons depend on raster images, web fonts, filters, scripts or remote resources.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexiaIcon = api;
})(typeof globalThis !== 'undefined' ? globalThis : undefined, function () {
  'use strict';

  const PALETTES = Object.freeze({
    dark: Object.freeze({ bg:'#24152F', bgDeep:'#190E24', bgLight:'#342042', gold:'#F1C67D', goldDark:'#BD854D', goldLight:'#FFE2A5', burgundy:'#682D48', burgundyLight:'#B14B67', parchment:'#FFF4DC', parchmentMid:'#F3DDB8', parchmentDark:'#CE9F75', ink:'#53314B', feather:'#FFE6B0', featherShade:'#D5A35D', featherLine:'#6A3F47', hairline:'#AD754F' }),
    light: Object.freeze({ bg:'#F3E9DC', bgDeep:'#E6D6C5', bgLight:'#FFF7ED', gold:'#714259', goldDark:'#543248', goldLight:'#A97066', burgundy:'#71364C', burgundyLight:'#99465B', parchment:'#563447', parchmentMid:'#714A5B', parchmentDark:'#A27B80', ink:'#F3E9DC', feather:'#71374D', featherShade:'#986275', featherLine:'#FFF4E5', hairline:'#825440' }),
    mono: Object.freeze({ bg:'#FFFFFF', bgDeep:'#FFFFFF', bgLight:'#FFFFFF', gold:'#17131A', goldDark:'#17131A', goldLight:'#17131A', burgundy:'#17131A', burgundyLight:'#17131A', parchment:'#17131A', parchmentMid:'#17131A', parchmentDark:'#17131A', ink:'#FFFFFF', feather:'#17131A', featherShade:'#17131A', featherLine:'#FFFFFF', hairline:'#FFFFFF' })
  });

  const PROFILES = Object.freeze({micro: {max:20, name:'Micro'}, compact:{max:40,name:'Compact'}, standard:{max:96,name:'Standard'}, premium:{max:Infinity,name:'Premium'}});
  const DESCRIPTION = '革装の古書を開き、羽根ペンで物語を書き始めるCodexiaのアイコン';
  const e = (str) => String(str).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  function chooseProfile(size, optical='auto') {
    if (optical !== 'auto') {
      if (!Object.hasOwn(PROFILES,optical)) throw new RangeError('Unknown optical profile');
      return optical;
    }
    if (size<=20) return 'micro';
    if (size<=40) return 'compact';
    if (size<=96) return 'standard';
    return 'premium';
  }
  function validate({size,mode,optical,layer,maskable}) {
    if (!Number.isInteger(size) || size<1 || size>4096) throw new RangeError('Size must be an integer in [1,4096]');
    if (!Object.hasOwn(PALETTES,mode)) throw new RangeError('Unknown palette');
    chooseProfile(size,optical);
    if (!['composite','background','book','quill','foreground','silhouette'].includes(layer)) throw new RangeError('Unknown layer');
    if (typeof maskable!=='boolean') throw new TypeError('maskable must be boolean');
  }
  const shapeBook = {
    // Optical master, 16px pixel grid: asymmetric crown, thick central V, no thin detail.
    micro: `
      <!-- At 16px the book is drawn on a deliberate half-pixel grid. -->
      <path d="M1.5 9 Q4 8 7.5 10 Q11.5 8 14.5 9 V13.5 Q11.5 12.5 8 15 Q4.5 12.5 1.5 13.5 Z" fill="{gold}"/>
      <path d="M2 8.5 Q4.5 8 7.5 10 V13.5 Q4.5 12 2 12.5 Z" fill="{parchment}"/>
      <path d="M8.5 10 Q11.5 8 14 8.5 V12.5 Q11.5 12 8.5 13.5 Z" fill="{parchment}"/>
      <path d="M8 10 V14.5" stroke="{ink}" stroke-width="1"/>`,
    // 32px: strong leather edge, two different page outlines and one spine valley.
    compact: `
      <path d="M2.1 17.4 Q8.8 13.6 15.6 20.2 Q22.3 13.6 29.9 17.4 L29.9 26.8 Q22.4 23.5 16 29.3 Q9.1 23.5 2.1 26.8 Z" fill="{gold}"/>
      <path d="M3.15 17.9 Q9.4 15 15.7 21 L15.7 27 Q9 22.4 3.15 25.25 Z M16.3 21 Q22.6 15 28.85 17.9 L28.85 25.25 Q23 22.4 16.3 27 Z" fill="{burgundy}"/>
      <path d="M4.15 15.9 Q9.3 14.2 15.45 19.05 L15.45 25.75 Q10.4 22.35 4.15 24 Z" fill="{parchment}"/>
      <path d="M16.55 19.05 Q23 14.2 27.85 15.9 L27.85 24 Q21.6 22.35 16.55 25.75 Z" fill="{parchment}"/>
      <path d="M16 19.1 L16 27.7" stroke="{goldDark}" stroke-width="1.05" stroke-linecap="round"/>`,
    standard: `
      <path d="M22 157 C58 141 93 146 128 173 C165 146 199 141 234 157 L234 210 C190 192 164 202 128 224 C93 202 66 192 22 210 Z" fill="{goldDark}"/>
      <path d="M24 154 C61 139 95 147 128 173 C166 146 202 138 232 154 L232 204 C184 188 160 201 128 220 C94 200 69 188 24 204 Z" fill="{gold}"/>
      <path d="M31 157 C63 146 94 157 126 180 L126 213 C96 192 64 186 31 197 Z M130 180 C163 157 195 146 225 157 L225 197 C191 186 160 192 130 213 Z" fill="{burgundy}"/>
      <path d="M36 115 C64 103 95 112 124 137 L124 201 C95 180 67 176 36 185 Z" fill="{parchmentMid}"/>
      <path d="M132 137 C161 112 192 103 220 115 L220 185 C189 176 161 180 132 201 Z" fill="{parchmentMid}"/>
      <path d="M39 110 C69 101 98 112 125 137 L125 198 C96 178 71 170 39 180 Z" fill="{parchment}"/>
      <path d="M131 137 C158 112 188 101 217 110 L217 180 C185 170 160 178 131 198 Z" fill="{parchment}"/>
      <path d="M128 136 L128 216" stroke="{goldDark}" stroke-width="4" stroke-linecap="round"/>
      <path d="M30 202 C63 191 95 200 126 219 M130 219 C161 200 193 191 226 202" fill="none" stroke="{goldLight}" stroke-width="2.5" stroke-linecap="round"/>`,
    premium: `
      <!-- Leather-bound cover, debossed edges, asymmetric page stacks -->
      <path d="M22 158 C57 142 93 145 128 173 C168 142 200 142 234 158 L234 207 C195 190 159 201 128 226 C91 200 60 189 22 207 Z" fill="{goldDark}"/>
      <path d="M23 154 C59 137 96 145 128 172 C164 145 200 138 233 154 L233 202 C190 186 162 200 128 221 C94 200 66 186 23 202 Z" fill="{gold}"/>
      <path d="M29 156 C65 142 99 160 126 182 L126 213 C95 188 63 185 29 196 Z M130 182 C162 155 194 142 227 156 L227 196 C192 185 159 188 130 213 Z" fill="{burgundy}"/>
      <path d="M32 159 Q62 152 91 168 M165 168 Q197 152 224 159" fill="none" stroke="{goldLight}" stroke-width="1.8" opacity=".9"/>
      <!-- Ribbon is embedded in the binding, not floating above the pages -->
      <path d="M68 177 C76 173 87 175 96 181 L88 227 L77 219 L65 226 Z" fill="{burgundyLight}"/>
      <path d="M70 179 C78 176 86 178 91 180 L85 217 L77 213 L70 220 Z" fill="{burgundy}"/>
      <!-- Gilded page block and paper curvature -->
      <path d="M33 122 Q80 107 124 144 L124 203 Q78 178 33 189 Z" fill="{parchmentDark}"/>
      <path d="M132 144 Q179 107 223 122 L223 189 Q176 178 132 203 Z" fill="{parchmentDark}"/>
      <path d="M36 114 C65 103 96 113 124 137 L124 198 Q85 175 36 181 Z" fill="{parchmentMid}"/>
      <path d="M132 137 C160 113 191 103 220 114 L220 181 Q170 175 132 198 Z" fill="{parchmentMid}"/>
      <!-- Main parchment spreads, modeled by two restrained vector gradients -->
      <path d="M39 107 C70 99 101 112 125 135 L125 196 C91 172 66 168 39 176 Q41 140 39 107 Z" fill="url(#{id}-leftPage)"/>
      <path d="M131 135 C157 112 187 99 217 107 Q215 140 217 176 C190 168 166 172 131 196 Z" fill="url(#{id}-rightPage)"/>
      <path d="M39 110 Q79 99 125 138 M131 138 Q174 100 217 110" stroke="{parchment}" stroke-width="2.3" fill="none" opacity=".75"/>
      <path d="M125 135 C125 156 126 177 126 199 M131 135 C130 155 130 177 130 199" fill="none" stroke="{parchmentDark}" stroke-width="1.35"/>
      <path d="M128 139 L128 216" stroke="{goldDark}" stroke-width="4" stroke-linecap="round"/>
      <!-- Gold gilding under the open folios -->
      <path d="M30 200 C63 191 92 198 125 218 M131 218 C165 198 194 191 226 200" fill="none" stroke="{goldLight}" stroke-width="2" stroke-linecap="round"/>
      <path d="M34 195 C69 185 95 199 120 210 M136 210 C160 198 189 185 222 195" fill="none" stroke="{goldDark}" stroke-width="1.3" opacity=".85"/>`
  };
  const shapeQuill = {
    micro: `<path d="M7.5 9.5 C7.5 6 9.5 3 13.5 1 C13 4.5 11 7.5 7.5 9.5 Z" fill="{gold}"/>
       <path d="M8 9 Q10.5 4 13 1.5" fill="none" stroke="{ink}" stroke-width="1"/>`,
    compact: `<path d="M13.2 19.1 C12.9 12 17.25 6.2 26.4 2.3 C25.8 10.7 21.3 16 13.2 19.1 Z" fill="{gold}"/>
       <path d="M13.4 18.8 C18.9 9.4 22.2 5.7 26.4 2.3" fill="none" stroke="{ink}" stroke-width="1.25" stroke-linecap="round"/>
       <path d="M13.2 19.1 L12.15 22.1" stroke="{goldDark}" stroke-width="1.15" stroke-linecap="round"/>`,
    standard: `<path d="M109 136 C105 93 141 52 193 31 C188 79 155 119 109 136 Z" fill="{feather}" stroke="{goldDark}" stroke-width="2" stroke-linejoin="round"/>
      <path d="M109 136 C137 79 169 49 193 31" fill="none" stroke="{featherLine}" stroke-width="4.1" stroke-linecap="round"/>
      <path d="M109 136 L100 158" stroke="{goldDark}" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M137 89 L161 83" stroke="{featherLine}" stroke-width="2.4" stroke-linecap="round"/>`,
    premium: `<path d="M107 138 C107 103 127 74 150 55 C165 41 181 33 196 29 C190 53 186 65 171 84 C156 105 132 128 107 138 Z" fill="url(#{id}-feather)" stroke="{goldDark}" stroke-width="1.35" stroke-linejoin="round"/>
      <!-- Three swept barbs give the silhouette the distinctive 'writing feather' profile -->
      <path d="M124 109 C128 86 150 63 176 47 C171 66 154 84 135 96 Z" fill="{feather}" opacity=".92"/>
      <path d="M133 109 C152 95 174 84 181 73 C178 92 158 109 131 123 Z" fill="{feather}" opacity=".96"/>
      <path d="M154 68 C168 56 183 47 192 32" fill="none" stroke="{parchment}" stroke-width="2.3" stroke-linecap="round" opacity=".75"/>
      <!-- Quill shaft and nibbled vanes: no fixed-width hairlines in compact masters -->
      <path d="M107 138 C134 83 168 50 196 29" fill="none" stroke="{featherLine}" stroke-width="3.2" stroke-linecap="round"/>
      <path d="M107 138 C131 97 164 57 193 30" fill="none" stroke="{goldLight}" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M140 86 L162 81 M129 101 L150 99 M154 66 L174 62" fill="none" stroke="{featherLine}" stroke-width="2" stroke-linecap="round"/>
      <path d="M107 138 L98 159" fill="none" stroke="{goldDark}" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M107 138 L100 154" fill="none" stroke="{goldLight}" stroke-width="1.5" stroke-linecap="round"/>`
  };

  // Native 24px master: integer/half-pixel geometry rather than a 0.75x-scaled 32px icon.
  // The palette and the semantic identity are shared with the four optical tiers.
  const native24 = Object.freeze({
    book: `<path d="M1.5 13.5 Q6.5 11 12 15.5 Q17.5 11 22.5 13.5 V20 Q17 18 12 22.5 Q7 18 1.5 20 Z" fill="{gold}"/>
      <path d="M2.5 13.5 Q7 12 11.5 16.5 V20 Q7 17 2.5 18.5 Z M12.5 16.5 Q17 12 21.5 13.5 V18.5 Q17 17 12.5 20 Z" fill="{burgundy}"/>
      <path d="M3.5 12 Q8 11.5 11.5 15 V19 Q8 17 3.5 18 Z" fill="{parchment}"/>
      <path d="M12.5 15 Q16 11.5 20.5 12 V18 Q16 17 12.5 19 Z" fill="{parchment}"/>
      <path d="M12 15.5 V21" stroke="{goldDark}" stroke-width="1"/>`,
    quill: `<path d="M10 14.5 C10 9 13.5 4.5 20 1.5 C19.5 7.5 15.5 12.5 10 14.5 Z" fill="{gold}"/>
      <path d="M10.5 14 Q14.5 7.5 19.5 2" stroke="{ink}" stroke-width="1" fill="none"/>
      <path d="M10 14.5 L9 16.5" stroke="{goldDark}" stroke-width="1"/>`
  });

  function interpolate(template, palette, id) {
    return template.replace(/\{([A-Za-z]+)\}/g, (all,key) => Object.hasOwn(palette,key) ? palette[key] : all).replaceAll('{id}',id);
  }
  function defs(id,p,optical,mode) {
    if (optical!=='premium') return '';
    return `<defs>
      <linearGradient id="${id}-leftPage" x1=".12" y1=".07" x2=".91" y2="1" objectBoundingBox="true"><stop offset="0" stop-color="${p.parchment}"/><stop offset=".60" stop-color="${p.parchment}"/><stop offset="1" stop-color="${p.parchmentMid}"/></linearGradient>
      <linearGradient id="${id}-rightPage" x1=".86" y1=".08" x2=".2" y2="1" objectBoundingBox="true"><stop offset="0" stop-color="${p.parchment}"/><stop offset=".60" stop-color="${p.parchment}"/><stop offset="1" stop-color="${p.parchmentMid}"/></linearGradient>
      <linearGradient id="${id}-feather" x1=".15" y1="1" x2=".88" y2=".1" objectBoundingBox="true"><stop offset="0" stop-color="${p.featherShade}"/><stop offset=".42" stop-color="${p.feather}"/><stop offset="1" stop-color="${p.goldLight}"/></linearGradient>
     </defs>`;
  }
  function renderIcon({size=1024,mode='dark',optical='auto',maskable=false,accessible=true,layer='composite',id='codexia'}={}) {
    validate({size,mode,optical,layer,maskable});
    const profile=chooseProfile(size,optical);
    const p=PALETTES[mode];
    const nativeSize24 = optical==='auto' && size===24;
    const isSmall=profile==='micro'||profile==='compact';
    // Small masters use their native pixel grid: no 256px illustration crushed down.
    const viewBox=nativeSize24?'0 0 24 24':profile==='micro'?'0 0 16 16':profile==='compact'?'0 0 32 32':'0 0 256 256';
    const prefix=String(id).replace(/[^A-Za-z0-9_-]/g,'_').slice(0,50) || 'codexia';
    const attr=accessible?`role="img" aria-label="${e(DESCRIPTION)}"`:'aria-hidden="true" focusable="false"';
    const book=interpolate(nativeSize24?native24.book:shapeBook[profile],p,prefix);
    const quill=interpolate(nativeSize24?native24.quill:shapeQuill[profile],p,prefix);
    // The composite is exactly the background, book and quill layers in this order.
    // This invariant matters for Apple Icon Composer parity.
    const artwork=layer==='background'?'':layer==='book'?book:layer==='quill'?quill:layer==='silhouette'?interpolate(nativeSize24?native24.book:shapeBook[profile],{...p,parchment:p.gold,burgundy:p.gold,ink:p.bg,goldDark:p.gold,goldLight:p.gold},prefix)+interpolate(nativeSize24?native24.quill:shapeQuill[profile],{...p,feather:p.gold,featherLine:p.bg},prefix):book+quill;
    const background=(layer==='composite'||layer==='background') ? `<rect width="${nativeSize24?24:isSmall?(profile==='micro'?16:32):256}" height="${nativeSize24?24:isSmall?(profile==='micro'?16:32):256}" fill="${p.bg}"/>` : '';
    const vSize=nativeSize24?24:profile==='micro'?16:profile==='compact'?32:256;
    const scale=maskable?'scale(.76)':'';
    const center=maskable?vSize/2:0;
    const transform=maskable?` transform="translate(${center} ${center}) ${scale} translate(${-center} ${-center})"`:'';
    const body=artwork?`<g${transform}>${artwork}</g>`:'';
    const title=accessible?`<title>${e(DESCRIPTION)}</title>`:'';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}" ${attr}>
${title}${defs(prefix,p,profile,mode)}${background}${body}</svg>`;
  }
  function renderLayers(opts={}) {
    const size=opts.size ?? 1024;
    return Object.freeze(Object.fromEntries(['background','book','quill'].map(layer=>[layer,renderIcon({...opts,size,layer,accessible:false})])));
  }
  return Object.freeze({PALETTES,PROFILES,DESCRIPTION,chooseProfile,renderIcon,renderLayers});
});