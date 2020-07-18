var canvas;
var ctx;

var dot;
var food_array;
var food;

var dots;
var food_x;
var food_y;

var movingLeft = false;
var movingRight = true;
var movingUp = false;
var movingDown = false;
var inGame = true;    

const TEXT_SIZE = 30;
const DOT_SIZE = 90;
const START_DOTS = 3;
const ALL_DOTS = 900;
const MAX_RAND = 10;
const DELAY = 120;
const C_HEIGHT = 900;
const C_WIDTH = 900;    

const BUTTON_WIDTH = 100;
const BUTTON_HEIGHT = 60;
const START_BUTTON_X = C_WIDTH/2 - BUTTON_WIDTH/2;
const START_BUTTON_Y = C_HEIGHT/2 - BUTTON_HEIGHT/2;
const YES_BUTTON_X = C_WIDTH/2 - BUTTON_WIDTH/2;
const YES_BUTTON_Y = C_HEIGHT/2 -100 + 2*TEXT_SIZE*1.5;
const NO_BUTTON_X = C_WIDTH/2 - BUTTON_WIDTH/2;
const NO_BUTTON_Y = C_HEIGHT/2 -100 + 2*TEXT_SIZE*1.5 + BUTTON_HEIGHT*1.5;

const LEFT_KEY = 37;
const RIGHT_KEY = 39;
const UP_KEY = 38;
const DOWN_KEY = 40;
const ALT_LEFT_KEY = 65;
const ALT_RIGHT_KEY = 68;
const ALT_DOWN_KEY = 83;
const ALT_UP_KEY = 87;


var x = new Array(ALL_DOTS);
var y = new Array(ALL_DOTS);   

var score_map = new Map();

function init() {
    
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d'); 

    loadImages();
    createScoreboard();

    ctx.fillStyle = 'white';
    ctx.fillRect(START_BUTTON_X, START_BUTTON_Y, BUTTON_WIDTH, BUTTON_HEIGHT);

    ctx.textBaseline = 'middle'; 
    ctx.textAlign = 'center'; 
    ctx.font = 'normal bold ' + String(TEXT_SIZE) +'px monospace';
    ctx.fillStyle = 'black';
    ctx.fillText('START', C_WIDTH/2, C_HEIGHT/2);
    canvas.addEventListener('click', clickStartButton);

    window.addEventListener("keydown", function(e) {
        if([32, 37, 38, 39, 40].indexOf(e.keyCode) > -1) {
            e.preventDefault();
        }
    }, false);

}    

function resetGame() {

    inGame = true;

    movingLeft = false;
    movingRight = true;
    movingUp = false;
    movingDown = false;

    inGame = true;    
    createScoreboard();
    createSnake();
    locateFood();
    setTimeout("gameCycle()", DELAY);

}

function loadImages() {
    
    dot = new Image();
    dot.src = 'dot.png'; 

    food_array = new Array();

    ryan_face = new Image();
    ryan_face.src = 'faces/ryan.png';
    food_array[0] = ryan_face;

    ray_face = new Image();
    ray_face.src = 'faces/ray.png';
    food_array[1] = ray_face;

    dev_face = new Image();
    dev_face.src = 'faces/dev.png';
    food_array[2] = dev_face;

    ben_face = new Image();
    ben_face.src = 'faces/ben.png';
    food_array[3] = ben_face;

    richard_face = new Image();
    richard_face.src = 'faces/richard.png';
    food_array[4] = richard_face;

    mike_face = new Image();
    mike_face.src = 'faces/mike.png';
    food_array[5] = mike_face;

    esben_face = new Image();
    esben_face.src = 'faces/esben.png';
    food_array[6] = esben_face;

    kier_face = new Image();
    kier_face.src = 'faces/kier.png';
    food_array[7] = kier_face;

}

function createSnake() {

    dots = START_DOTS;

    for (var z = 0; z < dots; z++) {
        x[z] = 180 - z * DOT_SIZE;
        y[z] = 180;
    }
}

function createScoreboard() {

    ctx.clearRect(900, 0, 300, 900);

    ctx.fillStyle = 'white';
    ctx.fillRect(900, 0, 300, 900);

    ctx.fillStyle = 'black';
    ctx.rect(905, 2, 153, 895);
    ctx.rect(905, 2, 153, 35);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = 'normal bold ' + String(TEXT_SIZE) +'px monospace';
    ctx.fillText("SCORE: 0", 910, 25);

    for(var i = 0; i < food_array.length; i++) {
        score_map[food_array[i].src] = 0;
    }


}

function updateScoreboard() {

    ctx.clearRect(900, 0, 300, 900);

    ctx.fillStyle = 'white';
    ctx.fillRect(900, 0, 300, 900);

    ctx.fillStyle = 'black';
    ctx.rect(905, 2, 153, 895);
    ctx.rect(905, 2, 153, 35);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = 'normal bold ' + String(TEXT_SIZE) +'px monospace';
    if(dots - START_DOTS < 10) {
        ctx.fillText("SCORE: " + String(dots - START_DOTS), 910, 25);
    }
    else {
        ctx.fillText("SCORE:" + String(dots - START_DOTS), 910, 25);
    }

    for(var i = 0; i < food_array.length; i++) {

        if(score_map[food_array[i].src] != 0) {
            ctx.drawImage(food_array[i], 
                          908, 
                          40 + i*(DOT_SIZE/2+5) + 10, 
                          DOT_SIZE/2, 
                          DOT_SIZE/2);
            ctx.fillText("x " + String(score_map[food_array[i].src]), 
                         955, 
                         60 + i*(DOT_SIZE/2 + 5) + 10);
        }

    }

}

function doDrawing() {
    
    ctx.clearRect(0, 0, C_WIDTH, C_HEIGHT);
    
    if (inGame) {

        ctx.drawImage(food, food_x, food_y, DOT_SIZE, DOT_SIZE);

        for (var z = 0; z < dots; z++) {
            
            ctx.drawImage(dot, x[z], y[z], DOT_SIZE, DOT_SIZE);
        }    
    } else {

        gameOver();
    }        
}

function gameOver() {
    
    ctx.fillStyle = 'white';
    ctx.textBaseline = 'middle'; 
    ctx.textAlign = 'center'; 
    ctx.font = 'normal bold ' + String(TEXT_SIZE) +'px monospace';
    
    var go_string = 'Game over, total score: ' + String(dots - START_DOTS);
    ctx.fillText(go_string, C_WIDTH/2, C_HEIGHT/2 -100);
    ctx.fillText('Play again?', C_WIDTH/2, C_HEIGHT/2 -100 + TEXT_SIZE*1.5);

    ctx.fillStyle = 'white';
    ctx.fillRect(YES_BUTTON_X, YES_BUTTON_Y, BUTTON_WIDTH, BUTTON_HEIGHT);
    ctx.fillRect(NO_BUTTON_X, NO_BUTTON_Y, BUTTON_WIDTH, BUTTON_HEIGHT);
                 
    ctx.fillStyle = 'black';
    ctx.fillText('YES', 
                 C_WIDTH/2, 
                 C_HEIGHT/2 -100 + 2*TEXT_SIZE*1.5 + 30);
    ctx.fillText('NO', 
                 C_WIDTH/2, 
                 C_HEIGHT/2 -100 + 2*TEXT_SIZE*1.5 + BUTTON_HEIGHT*1.5 + 30);

    updateScoreboard();
    canvas.addEventListener('click', clickGameOverButtons); 
}

function clickStartButton(event) {

    if (event.x > START_BUTTON_X && 
        event.x < START_BUTTON_X + BUTTON_WIDTH &&
        event.y > START_BUTTON_Y && 
        event.y < START_BUTTON_Y + BUTTON_HEIGHT) {
            createSnake();
            locateFood();
            setTimeout("gameCycle()", DELAY);
            canvas.removeEventListener('click', clickStartButton);
        } 
}

function clickGameOverButtons(event) {

    if (event.x > YES_BUTTON_X && 
        event.x < YES_BUTTON_X + BUTTON_WIDTH &&
        event.y > YES_BUTTON_Y && 
        event.y < YES_BUTTON_Y + BUTTON_HEIGHT) {
            resetGame();
            canvas.removeEventListener('click', clickGameOverButtons); 
        } 

    if (event.x > NO_BUTTON_X && 
        event.x < NO_BUTTON_X + BUTTON_WIDTH &&
        event.y > NO_BUTTON_Y && 
        event.y < NO_BUTTON_Y + BUTTON_HEIGHT) {
            document.getElementById("homeLink").click();
        } 
}
function checkFood() {

    if ((x[0] == food_x) && (y[0] == food_y)) {

        dots++;

        score_map[food.src] += 1;
        updateScoreboard();
        locateFood();
    }
}

function move() {

    for (var z = dots; z > 0; z--) {
        x[z] = x[(z - 1)];
        y[z] = y[(z - 1)];
    }

    if (movingLeft) x[0] -= DOT_SIZE;
    if (movingRight) x[0] += DOT_SIZE;
    if (movingUp) y[0] -= DOT_SIZE;
    if (movingDown) y[0] += DOT_SIZE;

}    

function checkCollision() {

    for (var z = dots; z > 0; z--) {

        self_col = (z > 4) && (x[0] == x[z]) && (y[0] == y[z]);
        if (self_col) inGame = false;
       
    }
    // Just trying to keep that sweet column count down...
    var ctx_col = y[0] >= C_HEIGHT || y[0] < 0 || x[0] >= C_WIDTH || x[0] < 0;
    if (ctx_col) inGame = false;
}

function locateFood() {

    var r = Math.floor(Math.random()*food_array.length);
    food = food_array[r];

    r = Math.floor(Math.random() * MAX_RAND);
    food_x = r * DOT_SIZE;

    r = Math.floor(Math.random() * MAX_RAND);
    food_y = r * DOT_SIZE;

}    

function gameCycle() {
    
    if (inGame) {

        checkFood();
        checkCollision();
        move();
        doDrawing();
        setTimeout("gameCycle()", DELAY);
    }
}

onkeydown = function(e) {
    
    var key = e.keyCode;
    
    if ((key == LEFT_KEY || key == ALT_LEFT_KEY) && (!movingRight)) {
        
        movingLeft = true;
        movingUp = false;
        movingDown = false;
    }

    if ((key == RIGHT_KEY || key == ALT_RIGHT_KEY) && (!movingLeft)) {
        
        movingRight = true;
        movingUp = false;
        movingDown = false;
    }

    if ((key == UP_KEY || key == ALT_UP_KEY) && (!movingDown)) {
        
        movingUp = true;
        movingRight = false;
        movingLeft = false;
    }

    if ((key == DOWN_KEY || key == ALT_DOWN_KEY) && (!movingUp)) {
        
        movingDown = true;
        movingRight = false;
        movingLeft = false;
    }        
};    