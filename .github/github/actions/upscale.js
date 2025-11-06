const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const cp = require('child_process');
const { URL } = require('url');
const fetch = global.fetch || require('node-fetch');

function log(...args){ console.log(...args) }
function exec(cmd, opts = {}) {
  return cp.execSync(cmd, { stdio: 'inherit', ...opts });
}

(async () => {
  try {
    const token = process.env.GITHUB_TOKEN;
    const comment = process.env.COMMENT_BODY || '';
    const issueNumber = process.env.ISSUE_NUMBER;
    const repo = process.env.REPOSITORY; // owner/repo
    if (!token || !issueNumber || !repo) throw new Error('Missing required environment variables');

    // parse scale from comment: "/upscale 2" or "/upscale 3.5"
    let scale = 2;
    const m = comment.match(/\/upscale\s+([0-9]*\.?[0-9]+)/i);
    if (m) scale = parseFloat(m[1]) || 2;
    log('Requested scale:', scale);

    const [owner, repoName] = repo.split('/');

    // fetch issue to get body
    const issueRes = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}`, {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }
    });
    if (!issueRes.ok) throw new Error(`Failed to fetch issue: ${issueRes.status}`);
    const issue = await issueRes.json();
    const body = issue.body || '';

    // find first image URL (png/jpg/jpeg/webp)
    const imgRegex = /(https?:\/\/\S+\.(?:png|jpe?g|webp))/i;
    const imgMatch = body.match(imgRegex);
    if (!imgMatch) {
      // reply comment: no image found
      await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments`, {
        method: 'POST',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: `:warning: Tidak menemukan gambar di body issue. Silakan upload gambar di body issue terlebih dahulu.` })
      });
      console.log('No image found in issue body.');
      return;
    }
    const imageUrl = imgMatch[1];
    log('Found image URL:', imageUrl);

    // download image
    const urlObj = new URL(imageUrl);
    const origExt = path.extname(urlObj.pathname).toLowerCase() || '.jpg';
    const tmpDir = path.join(process.cwd(), 'tmp_upscale');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const inputPath = path.join(tmpDir, `input${origExt}`);
    log('Downloading image to', inputPath);
    const r = await fetch(imageUrl, { headers: { 'User-Agent': 'github-actions-upscale' } });
    if (!r.ok) throw new Error(`Failed to download image: ${r.status}`);
    const arrayBuffer = await r.arrayBuffer();
    fs.writeFileSync(inputPath, Buffer.from(arrayBuffer));

    // process with sharp
    const image = sharp(inputPath);
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) throw new Error('Invalid image metadata');
    const newWidth = Math.round(metadata.width * scale);
    const newHeight = Math.round(metadata.height * scale);
    log(`Resizing ${metadata.width}x${metadata.height} -> ${newWidth}x${newHeight}`);

    const outName = `upscaled-issue${issueNumber}-${Date.now()}${origExt}`;
    const outRelPath = path.posix.join('results', outName);
    const outPath = path.join(process.cwd(), outRelPath);
    if (!fs.existsSync(path.dirname(outPath))) fs.mkdirSync(path.dirname(outPath), { recursive: true });

    let pipeline = sharp(inputPath).resize(newWidth, newHeight, { kernel: sharp.kernel.lanczos3 }).sharpen();
    if (origExt === '.png') {
      await pipeline.png().toFile(outPath);
    } else if (origExt === '.webp') {
      await pipeline.webp({ quality: 90 }).toFile(outPath);
    } else {
      await pipeline.jpeg({ quality: 90 }).toFile(outPath);
    }
    log('Upscaled image saved to', outPath);

    // commit the result into branch upscaled-results
    const authRemote = `https://x-access-token:${token}@github.com/${owner}/${repoName}.git`;
    exec('git config --global user.email "github-actions[bot]@users.noreply.github.com"');
    exec('git config --global user.name "github-actions[bot]"');

    // ensure origin url uses token (replace remote)
    exec(`git remote set-url origin ${authRemote}`);

    // fetch branch
    exec('git fetch origin');

    // checkout or create branch
    let branchExists = true;
    try {
      exec('git rev-parse --verify origin/upscaled-results');
    } catch (e) {
      branchExists = false;
    }

    if (branchExists) {
      exec('git checkout -B upscaled-results origin/upscaled-results');
    } else {
      exec('git checkout --orphan upscaled-results');
      // clear worktree
      try { exec('git rm -rf .'); } catch (e) { /* ignore */ }
    }

    // copy file into repo working dir
    const destPath = path.join(process.cwd(), outRelPath);
    // file already in place (we created inside repo), so just add & commit
    exec(`git add ${outRelPath}`);
    try {
      exec(`git commit -m "Add upscaled image for issue #${issueNumber}: ${outName}"`);
    } catch (e) {
      // nothing to commit?
      console.log('Commit may have failed (nothing to commit).', e);
    }
    // push branch
    exec('git push origin upscaled-results --force');

    // construct raw.githubusercontent link
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repoName}/upscaled-results/${outRelPath}`;

    // post comment with link
    const commentBody = `:white_check_mark: Upscaled image (scale ${scale}x) dibuat dan disimpan di branch \`upscaled-results\`.\n\nTautan langsung (raw): ${rawUrl}\n\nJika ingin mengunduh file, buka tautan raw atau lihat branch \`upscaled-results\`.`;
    await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: commentBody })
    });

    log('Done. Comment posted with link:', rawUrl);
  } catch (err) {
    console.error('Error in upscale action:', err);
    // try to post error comment if possible
    try {
      const token = process.env.GITHUB_TOKEN;
      const [owner, repoName] = (process.env.REPOSITORY || '').split('/');
      const issueNumber = process.env.ISSUE_NUMBER;
      if (token && owner && repoName && issueNumber) {
        await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/comments`, {
          method: 'POST',
          headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: `:x: Terjadi error saat proses upscale: ${String(err.message).slice(0, 200)}` })
        });
      }
    } catch (e) {
      console.error('Also failed to post error comment:', e);
    }
    process.exit(1);
  }
})();
