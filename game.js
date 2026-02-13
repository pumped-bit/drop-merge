(function () {
    'use strict';

    const { Engine, Bodies, Body, Events, Composite, World } = Matter;

    // ======================== CONFIGURATION ========================
    const CANVAS_W = 400;
    const CANVAS_H = 650;
    const WALL_T = 12;
    const DROP_Y = 80;
    const DANGER_Y = DROP_Y + 30;
    const DROP_COOLDOWN = 450;
    const SETTLE_SPEED = 1.5;

    const FRUITS = [
        { radius: 16, color: '#FF6B6B', emoji: '🍒', name: 'Cherry', score: 1 },
        { radius: 24, color: '#C084FC', emoji: '🍇', name: 'Grape', score: 3 },
        { radius: 32, color: '#FB923C', emoji: '🍊', name: 'Orange', score: 6 },
        { radius: 40, color: '#EF4444', emoji: '🍎', name: 'Apple', score: 10 },
        { radius: 50, color: '#86EFAC', emoji: '🍐', name: 'Pear', score: 15 },
        { radius: 58, color: '#FBBF24', emoji: '🍋', name: 'Lemon', score: 21 },
        { radius: 68, color: '#FB7185', emoji: '🍑', name: 'Peach', score: 28 },
        { radius: 80, color: '#F97316', emoji: '🥭', name: 'Mango', score: 36 },
        { radius: 92, color: '#67E8F9', emoji: '🍈', name: 'Melon', score: 45 },
        { radius: 106, color: '#22C55E', emoji: '🍉', name: 'Watermelon', score: 55 },
    ];

    const DROP_WEIGHTS = [32, 28, 22, 12, 6]; // only first 5 can be dropped

    // ===================== ADS CONFIG =====================
    // Replace with your Adsgram block ID after registering at https://adsgram.ai
    const ADSGRAM_BLOCK_ID = '8107176240';
    const MAX_AD_CONTINUES = 2; // max continues per game session via ads

    // ===================== BOT CONFIG =====================
    // Replace with your bot username (without @) after creating it via BotFather
    const BOT_USERNAME = 'FruitDropGameBot';

    // ======================== STATE ========================
    let canvas, ctx, nextCanvas, nextCtx;
    let engine;
    let state;
    let particles = [];
    let scorePopups = [];
    let mergeQueue = [];
    let audioCtx = null;
    let gameLoopId = null;
    let adController = null;

    function freshState() {
        return {
            score: 0,
            bestScore: parseInt(localStorage.getItem('dm-best') || '0', 10),
            currentFruit: randomFruitLevel(),
            nextFruit: randomFruitLevel(),
            canDrop: true,
            isGameOver: false,
            gameRunning: false,
            dropX: CANVAS_W / 2,
            comboCount: 0,
            comboTimer: null,
            settled: new Set(),
            adContinuesUsed: 0,
            gamesPlayed: parseInt(localStorage.getItem('dm-games') || '0', 10),
        };
    }

    // ======================== UTILITIES ========================
    function randomFruitLevel() {
        const total = DROP_WEIGHTS.reduce((a, b) => a + b, 0);
        let r = Math.random() * total;
        for (let i = 0; i < DROP_WEIGHTS.length; i++) {
            r -= DROP_WEIGHTS[i];
            if (r <= 0) return i;
        }
        return 0;
    }

    function clampDropX(x, level) {
        const r = FRUITS[level].radius;
        return Math.max(WALL_T + r + 1, Math.min(CANVAS_W - WALL_T - r - 1, x));
    }

    function getCanvasPos(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: (clientX - rect.left) * (CANVAS_W / rect.width),
            y: (clientY - rect.top) * (CANVAS_H / rect.height),
        };
    }

    function hexToRgb(hex) {
        const n = parseInt(hex.slice(1), 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }

    function lighten(hex, pct) {
        const c = hexToRgb(hex);
        const f = pct / 100;
        return `rgb(${Math.min(255, c.r + (255 - c.r) * f)|0},${Math.min(255, c.g + (255 - c.g) * f)|0},${Math.min(255, c.b + (255 - c.b) * f)|0})`;
    }

    function darken(hex, pct) {
        const c = hexToRgb(hex);
        const f = 1 - pct / 100;
        return `rgb(${(c.r * f)|0},${(c.g * f)|0},${(c.b * f)|0})`;
    }

    // ======================== AUDIO ========================
    function ensureAudio() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }

    function playSound(freq, endFreq, duration, type, vol) {
        if (!audioCtx) return;
        try {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.type = type || 'sine';
            osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(endFreq, audioCtx.currentTime + duration);
            gain.gain.setValueAtTime(vol || 0.15, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
            osc.start(audioCtx.currentTime);
            osc.stop(audioCtx.currentTime + duration);
        } catch (_) { /* ignore audio errors */ }
    }

    function playDropSound() {
        playSound(250, 100, 0.1, 'sine', 0.12);
    }

    function playMergeSound(level) {
        const f = 350 + level * 55;
        playSound(f, f * 1.4, 0.18, 'sine', 0.18);
    }

    function playGameOverSound() {
        playSound(300, 60, 0.5, 'sawtooth', 0.12);
    }

    // ======================== HAPTICS ========================
    function haptic(type) {
        try {
            if (window.Telegram?.WebApp?.HapticFeedback) {
                if (type === 'light') Telegram.WebApp.HapticFeedback.impactOccurred('light');
                else if (type === 'heavy') Telegram.WebApp.HapticFeedback.impactOccurred('heavy');
                else if (type === 'error') Telegram.WebApp.HapticFeedback.notificationOccurred('error');
                else if (type === 'success') Telegram.WebApp.HapticFeedback.notificationOccurred('success');
            }
        } catch (_) {}
    }

    // ======================== PHYSICS ========================
    function initPhysics() {
        engine = Engine.create({
            gravity: { x: 0, y: 1.8 },
        });

        // Walls
        const wallOpts = { isStatic: true, friction: 0.3, restitution: 0.1, label: 'wall' };
        const leftWall = Bodies.rectangle(WALL_T / 2, CANVAS_H / 2, WALL_T, CANVAS_H, wallOpts);
        const rightWall = Bodies.rectangle(CANVAS_W - WALL_T / 2, CANVAS_H / 2, WALL_T, CANVAS_H, wallOpts);
        const floor = Bodies.rectangle(CANVAS_W / 2, CANVAS_H - WALL_T / 2, CANVAS_W, WALL_T, wallOpts);

        Composite.add(engine.world, [leftWall, rightWall, floor]);

        // Collision handler for merging
        Events.on(engine, 'collisionStart', function (event) {
            for (let i = 0; i < event.pairs.length; i++) {
                const { bodyA, bodyB } = event.pairs[i];
                if (bodyA.fruitLevel != null && bodyB.fruitLevel != null &&
                    bodyA.fruitLevel === bodyB.fruitLevel &&
                    !bodyA.isMerging && !bodyB.isMerging &&
                    bodyA.fruitLevel < FRUITS.length - 1) {
                    mergeQueue.push({ a: bodyA, b: bodyB });
                }
            }
        });
    }

    function createFruitBody(x, y, level) {
        const fruit = FRUITS[level];
        const body = Bodies.circle(x, y, fruit.radius, {
            restitution: 0.15,
            friction: 0.4,
            frictionAir: 0.01,
            density: 0.0015,
            label: 'fruit',
            fruitLevel: level,
            isMerging: false,
            dropTime: Date.now(),
        });
        Composite.add(engine.world, body);
        return body;
    }

    // ======================== MERGE SYSTEM ========================
    function processMerges() {
        const toProcess = mergeQueue.splice(0);
        for (let i = 0; i < toProcess.length; i++) {
            const { a, b } = toProcess[i];
            if (a.isMerging || b.isMerging) continue;

            a.isMerging = true;
            b.isMerging = true;

            const newLevel = a.fruitLevel + 1;
            const mx = (a.position.x + b.position.x) / 2;
            const my = (a.position.y + b.position.y) / 2;

            Composite.remove(engine.world, a);
            Composite.remove(engine.world, b);

            if (newLevel < FRUITS.length) {
                const newBody = createFruitBody(mx, my, newLevel);
                // Give slight upward impulse for satisfying pop
                Body.setVelocity(newBody, { x: 0, y: -2 });
            }

            // Score with combo
            state.comboCount++;
            clearTimeout(state.comboTimer);
            state.comboTimer = setTimeout(() => { state.comboCount = 0; }, 600);

            const baseScore = FRUITS[newLevel < FRUITS.length ? newLevel : FRUITS.length - 1].score;
            const points = baseScore * Math.max(1, state.comboCount);
            state.score += points;

            // Effects
            spawnMergeParticles(mx, my, newLevel < FRUITS.length ? newLevel : FRUITS.length - 1);
            scorePopups.push({ x: mx, y: my, points, life: 1.0, combo: state.comboCount });
            playMergeSound(newLevel);
            haptic(newLevel >= 5 ? 'heavy' : 'light');

            updateHUD();
        }
    }

    // ======================== PARTICLES ========================
    function spawnMergeParticles(x, y, level) {
        const color = FRUITS[level].color;
        const count = 10 + level * 2;
        for (let i = 0; i < count; i++) {
            const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.8;
            const speed = 2 + Math.random() * 4 + level * 0.5;
            particles.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                radius: 2.5 + Math.random() * 3.5,
                color,
                life: 1.0,
                decay: 0.018 + Math.random() * 0.015,
            });
        }
    }

    function updateParticles() {
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.12;
            p.life -= p.decay;
            if (p.life <= 0) particles.splice(i, 1);
        }
    }

    function updateScorePopups() {
        for (let i = scorePopups.length - 1; i >= 0; i--) {
            const p = scorePopups[i];
            p.y -= 1.2;
            p.life -= 0.02;
            if (p.life <= 0) scorePopups.splice(i, 1);
        }
    }

    // ======================== DROP ========================
    function drop() {
        if (!state.canDrop || state.isGameOver) return;

        ensureAudio();
        state.canDrop = false;

        const level = state.currentFruit;
        const x = clampDropX(state.dropX, level);
        createFruitBody(x, DROP_Y, level);

        playDropSound();
        haptic('light');

        state.currentFruit = state.nextFruit;
        state.nextFruit = randomFruitLevel();
        drawNextPreview();

        setTimeout(() => {
            if (!state.isGameOver) state.canDrop = true;
        }, DROP_COOLDOWN);
    }

    // ======================== GAME OVER CHECK ========================
    function checkGameOver() {
        if (state.isGameOver) return;

        const bodies = Composite.allBodies(engine.world);
        const now = Date.now();

        for (let i = 0; i < bodies.length; i++) {
            const b = bodies[i];
            if (b.fruitLevel == null || b.isStatic || b.isMerging) continue;

            // Grace period after drop
            if (now - b.dropTime < 1200) continue;

            const speed = Math.sqrt(b.velocity.x * b.velocity.x + b.velocity.y * b.velocity.y);
            const topEdge = b.position.y - FRUITS[b.fruitLevel].radius;

            if (topEdge < DANGER_Y && speed < SETTLE_SPEED) {
                gameOver();
                return;
            }
        }
    }

    function gameOver() {
        state.isGameOver = true;
        state.canDrop = false;
        playGameOverSound();
        haptic('error');

        state.gamesPlayed++;
        localStorage.setItem('dm-games', state.gamesPlayed);

        const isNewBest = state.score > state.bestScore;
        if (isNewBest) {
            state.bestScore = state.score;
            localStorage.setItem('dm-best', state.bestScore);
        }

        document.getElementById('final-score').textContent = state.score;
        document.getElementById('new-best').classList.toggle('hidden', !isNewBest);

        // Show "Watch Ad to Continue" only if continues are available
        const canContinue = state.adContinuesUsed < MAX_AD_CONTINUES && adController;
        document.getElementById('continue-ad-btn').classList.toggle('hidden', !canContinue);

        document.getElementById('game-over-screen').classList.remove('hidden');

        updateHUD();
    }

    // ======================== AD CONTINUE ========================
    function initAds() {
        try {
            if (window.Adsgram && ADSGRAM_BLOCK_ID !== 'YOUR_BLOCK_ID_HERE') {
                adController = window.Adsgram.init({ blockId: ADSGRAM_BLOCK_ID });
            }
        } catch (_) {
            adController = null;
        }
    }

    function continueWithAd() {
        if (!adController) return;

        adController.show().then(function () {
            // Ad watched successfully — revive the player
            state.adContinuesUsed++;
            state.isGameOver = false;
            state.canDrop = true;

            // Remove the top few fruits to give breathing room
            removeDangerFruits();

            document.getElementById('game-over-screen').classList.add('hidden');

            haptic('success');
            if (!state.gameRunning) {
                state.gameRunning = true;
                gameLoopId = requestAnimationFrame(gameLoop);
            }
        }).catch(function () {
            // Ad failed or user closed early — do nothing, they stay on game over
        });
    }

    function removeDangerFruits() {
        // Remove the 2 highest fruits to give the player a chance
        const bodies = Composite.allBodies(engine.world);
        const fruits = [];
        for (let i = 0; i < bodies.length; i++) {
            if (bodies[i].fruitLevel != null && !bodies[i].isStatic) {
                fruits.push(bodies[i]);
            }
        }
        fruits.sort(function (a, b) { return a.position.y - b.position.y; });

        const removeCount = Math.min(2, fruits.length);
        for (let i = 0; i < removeCount; i++) {
            spawnMergeParticles(fruits[i].position.x, fruits[i].position.y, fruits[i].fruitLevel);
            Composite.remove(engine.world, fruits[i]);
        }
    }

    // ======================== RENDERING ========================
    function initCanvas() {
        canvas = document.getElementById('game-canvas');
        ctx = canvas.getContext('2d');
        nextCanvas = document.getElementById('next-canvas');
        nextCtx = nextCanvas.getContext('2d');

        // Size canvas based on available space
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
    }

    function resizeCanvas() {
        const container = document.getElementById('game-container');
        const hud = document.getElementById('hud');
        const availW = Math.min(container.clientWidth, 440);
        const availH = container.clientHeight - hud.offsetHeight;

        // Determine scale to fit
        const scaleW = availW / CANVAS_W;
        const scaleH = availH / CANVAS_H;
        const scale = Math.min(scaleW, scaleH, 1.0);

        canvas.width = CANVAS_W;
        canvas.height = CANVAS_H;
        canvas.style.width = (CANVAS_W * scale) + 'px';
        canvas.style.height = (CANVAS_H * scale) + 'px';
    }

    function render() {
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);

        // Background
        ctx.fillStyle = '#161625';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        // Play area background
        ctx.fillStyle = '#1c1c30';
        ctx.fillRect(WALL_T, 0, CANVAS_W - WALL_T * 2, CANVAS_H - WALL_T);

        // Walls
        drawWalls();

        // Danger zone
        drawDangerZone();

        // Drop guide line
        if (state.canDrop && !state.isGameOver && state.gameRunning) {
            drawDropGuide();
        }

        // Fruits
        const bodies = Composite.allBodies(engine.world);
        for (let i = 0; i < bodies.length; i++) {
            if (bodies[i].fruitLevel != null && !bodies[i].isMerging) {
                drawFruit(bodies[i]);
            }
        }

        // Drop preview
        if (state.canDrop && !state.isGameOver && state.gameRunning) {
            drawDropPreview();
        }

        // Particles
        drawParticles();

        // Score popups
        drawScorePopups();

        // Combo indicator
        if (state.comboCount > 1) {
            drawCombo();
        }
    }

    function drawWalls() {
        const gradient = ctx.createLinearGradient(0, 0, WALL_T, 0);
        gradient.addColorStop(0, '#2d2d4a');
        gradient.addColorStop(1, '#232340');

        // Left wall
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, WALL_T, CANVAS_H);

        // Right wall
        const gradR = ctx.createLinearGradient(CANVAS_W - WALL_T, 0, CANVAS_W, 0);
        gradR.addColorStop(0, '#232340');
        gradR.addColorStop(1, '#2d2d4a');
        ctx.fillStyle = gradR;
        ctx.fillRect(CANVAS_W - WALL_T, 0, WALL_T, CANVAS_H);

        // Floor
        ctx.fillStyle = '#2d2d4a';
        ctx.fillRect(0, CANVAS_H - WALL_T, CANVAS_W, WALL_T);

        // Inner border highlights
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(WALL_T, 0);
        ctx.lineTo(WALL_T, CANVAS_H - WALL_T);
        ctx.lineTo(CANVAS_W - WALL_T, CANVAS_H - WALL_T);
        ctx.lineTo(CANVAS_W - WALL_T, 0);
        ctx.stroke();
    }

    function drawDangerZone() {
        // Check if any fruit is near danger
        let danger = false;
        const bodies = Composite.allBodies(engine.world);
        for (let i = 0; i < bodies.length; i++) {
            const b = bodies[i];
            if (b.fruitLevel == null || b.isStatic) continue;
            if (Date.now() - b.dropTime < 1200) continue;
            const topEdge = b.position.y - FRUITS[b.fruitLevel].radius;
            if (topEdge < DANGER_Y + 40) { danger = true; break; }
        }

        // Danger line
        ctx.save();
        ctx.setLineDash([8, 6]);
        ctx.strokeStyle = danger
            ? `rgba(255, 80, 80, ${0.5 + 0.3 * Math.sin(Date.now() * 0.008)})`
            : 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(WALL_T, DANGER_Y);
        ctx.lineTo(CANVAS_W - WALL_T, DANGER_Y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Red glow when danger
        if (danger) {
            const glow = ctx.createLinearGradient(0, 0, 0, DANGER_Y + 40);
            glow.addColorStop(0, `rgba(255, 50, 50, ${0.08 + 0.06 * Math.sin(Date.now() * 0.006)})`);
            glow.addColorStop(1, 'rgba(255, 50, 50, 0)');
            ctx.fillStyle = glow;
            ctx.fillRect(WALL_T, 0, CANVAS_W - WALL_T * 2, DANGER_Y + 40);
        }
    }

    function drawDropGuide() {
        const x = clampDropX(state.dropX, state.currentFruit);
        ctx.save();
        ctx.setLineDash([4, 8]);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, DROP_Y);
        ctx.lineTo(x, CANVAS_H - WALL_T);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    function drawDropPreview() {
        const level = state.currentFruit;
        const fruit = FRUITS[level];
        const x = clampDropX(state.dropX, level);
        const y = DROP_Y - fruit.radius - 8;

        ctx.save();
        ctx.globalAlpha = 0.6;

        // Circle
        ctx.beginPath();
        ctx.arc(x, y, fruit.radius, 0, Math.PI * 2);
        ctx.fillStyle = fruit.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Emoji
        ctx.globalAlpha = 0.8;
        ctx.font = `${fruit.radius * 0.9}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fruit.emoji, x, y);

        ctx.restore();
    }

    function drawFruit(body) {
        const fruit = FRUITS[body.fruitLevel];
        const x = body.position.x;
        const y = body.position.y;
        const r = fruit.radius;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(body.angle);

        // Shadow
        ctx.beginPath();
        ctx.arc(2, 3, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
        ctx.fill();

        // Main circle gradient
        const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.1, 0, 0, r);
        grad.addColorStop(0, lighten(fruit.color, 18));
        grad.addColorStop(0.6, fruit.color);
        grad.addColorStop(1, darken(fruit.color, 20));

        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // Border
        ctx.strokeStyle = darken(fruit.color, 25);
        ctx.lineWidth = 2;
        ctx.stroke();

        // Highlight (small, at the edge so it doesn't cover the emoji)
        ctx.beginPath();
        ctx.arc(-r * 0.38, -r * 0.38, r * 0.2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.fill();

        // Emoji (unrotate for upright text, drawn last and large)
        ctx.rotate(-body.angle);
        ctx.font = `${r * 1.1}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fruit.emoji, 0, 1);

        ctx.restore();
    }

    function drawParticles() {
        for (let i = 0; i < particles.length; i++) {
            const p = particles[i];
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.radius * p.life, 0, Math.PI * 2);
            ctx.globalAlpha = p.life;
            ctx.fillStyle = p.color;
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    function drawScorePopups() {
        for (let i = 0; i < scorePopups.length; i++) {
            const p = scorePopups[i];
            ctx.globalAlpha = Math.min(1, p.life * 2);
            ctx.font = `bold ${p.combo > 1 ? 28 : 22}px Arial, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillStyle = p.combo > 2 ? '#ff6b6b' : '#fbbf24';
            ctx.fillText(`+${p.points}`, p.x, p.y);
            if (p.combo > 1) {
                ctx.font = 'bold 16px Arial, sans-serif';
                ctx.fillStyle = '#c084fc';
                ctx.fillText(`×${p.combo} combo!`, p.x, p.y + 22);
            }
        }
        ctx.globalAlpha = 1;
    }

    function drawCombo() {
        const alpha = 0.3 + 0.2 * Math.sin(Date.now() * 0.01);
        ctx.globalAlpha = alpha;
        ctx.font = 'bold 60px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(`×${state.comboCount}`, CANVAS_W / 2, CANVAS_H / 2);
        ctx.globalAlpha = 1;
    }

    function drawNextPreview() {
        const fruit = FRUITS[state.nextFruit];
        nextCtx.clearRect(0, 0, 60, 60);

        const cx = 30, cy = 30;
        const displayR = Math.min(22, fruit.radius);

        const grad = nextCtx.createRadialGradient(cx - 4, cy - 4, 2, cx, cy, displayR);
        grad.addColorStop(0, lighten(fruit.color, 30));
        grad.addColorStop(1, fruit.color);

        nextCtx.beginPath();
        nextCtx.arc(cx, cy, displayR, 0, Math.PI * 2);
        nextCtx.fillStyle = grad;
        nextCtx.fill();

        nextCtx.font = `${displayR}px serif`;
        nextCtx.textAlign = 'center';
        nextCtx.textBaseline = 'middle';
        nextCtx.fillText(fruit.emoji, cx, cy + 1);
    }

    // ======================== HUD ========================
    function updateHUD() {
        document.getElementById('score').textContent = state.score;
        document.getElementById('best-score').textContent = state.bestScore;
    }

    // ======================== INPUT ========================
    function setupInput() {
        // Mouse
        canvas.addEventListener('mousemove', function (e) {
            const pos = getCanvasPos(e.clientX, e.clientY);
            state.dropX = pos.x;
        });

        canvas.addEventListener('click', function (e) {
            const pos = getCanvasPos(e.clientX, e.clientY);
            state.dropX = pos.x;
            drop();
        });

        // Touch
        canvas.addEventListener('touchstart', function (e) {
            e.preventDefault();
            const touch = e.touches[0];
            const pos = getCanvasPos(touch.clientX, touch.clientY);
            state.dropX = pos.x;
        }, { passive: false });

        canvas.addEventListener('touchmove', function (e) {
            e.preventDefault();
            const touch = e.touches[0];
            const pos = getCanvasPos(touch.clientX, touch.clientY);
            state.dropX = pos.x;
        }, { passive: false });

        canvas.addEventListener('touchend', function (e) {
            e.preventDefault();
            drop();
        }, { passive: false });
    }

    // ======================== TELEGRAM ========================
    function initTelegram() {
        if (window.Telegram?.WebApp) {
            const tg = Telegram.WebApp;
            tg.ready();
            tg.expand();
            try {
                tg.setHeaderColor('#0f0f1a');
                tg.setBackgroundColor('#0f0f1a');
            } catch (_) {}
        }
    }

    function getGameLink() {
        if (BOT_USERNAME !== 'YourBotUsername') {
            return `https://t.me/${BOT_USERNAME}/game`;
        }
        return window.location.href;
    }

    function shareScore() {
        const link = getGameLink();
        const text = `🍉 I scored ${state.score} in Drop & Merge! Can you beat my score?`;
        telegramShare(link, text);
    }

    function challengeFriend() {
        const link = getGameLink();
        const text = `🎯 I just got ${state.score} points in Drop & Merge! I bet you can't beat that. Try it:`;
        telegramShare(link, text);
    }

    function telegramShare(url, text) {
        const encodedUrl = encodeURIComponent(url);
        const encodedText = encodeURIComponent(text);
        if (window.Telegram?.WebApp) {
            try {
                Telegram.WebApp.openTelegramLink(
                    `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`
                );
                return;
            } catch (_) {}
        }
        if (navigator.share) {
            navigator.share({ title: 'Drop & Merge', text: text, url: url }).catch(function () {});
        }
    }

    // ======================== GAME LOOP ========================
    function gameLoop(timestamp) {
        if (!state.gameRunning) return;

        Engine.update(engine, 1000 / 60);

        processMerges();
        updateParticles();
        updateScorePopups();
        checkGameOver();

        render();

        gameLoopId = requestAnimationFrame(gameLoop);
    }

    // ======================== GAME LIFECYCLE ========================
    function startGame() {
        // Clear previous
        if (engine) {
            Engine.clear(engine);
        }
        if (gameLoopId) {
            cancelAnimationFrame(gameLoopId);
        }

        state = freshState();
        particles = [];
        scorePopups = [];
        mergeQueue = [];

        initPhysics();
        updateHUD();
        drawNextPreview();

        state.gameRunning = true;
        state.canDrop = true;

        document.getElementById('start-screen').classList.add('hidden');
        document.getElementById('game-over-screen').classList.add('hidden');

        gameLoopId = requestAnimationFrame(gameLoop);
    }

    function restart() {
        startGame();
    }

    // ======================== INITIALIZATION ========================
    function init() {
        initCanvas();
        initTelegram();
        initAds();
        setupInput();

        state = freshState();
        updateHUD();
        drawNextPreview();

        // Render one frame for the background behind start screen
        initPhysics();
        render();

        // Button handlers
        document.getElementById('play-btn').addEventListener('click', function () {
            ensureAudio();
            startGame();
        });

        document.getElementById('restart-btn').addEventListener('click', function () {
            restart();
        });

        document.getElementById('share-btn').addEventListener('click', function () {
            shareScore();
        });

        document.getElementById('challenge-btn').addEventListener('click', function () {
            challengeFriend();
        });

        document.getElementById('continue-ad-btn').addEventListener('click', function () {
            continueWithAd();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
